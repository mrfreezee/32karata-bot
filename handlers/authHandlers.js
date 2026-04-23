// handlers/authHandlers.js
const { getClientByPhone, checkClientExists, saveClientToDB } = require('../services/clientService');
const { requestContactKeyboard, confirmKeyboard, agreeKeyboard } = require('../keyboards/keyboards');
const { cleanPhoneNumber } = require('../utils/phoneHelper');
const { pgPool } = require('../db');

const userStates = new Map();

// Основная функция авторизации
async function authorizeUser(ctx, userId, userName, startParam) {
    console.log(new Date().toISOString(), 'Авторизация пользователя:', userId, userName);

    if (!userId) {
        console.error('❌ Не удалось получить userId');
        await ctx.reply('Ошибка авторизации. Пожалуйста, попробуйте позже.');
        return false;
    }

    let referrerId = null;
    
    if (startParam && startParam.length >= 6) {
        try {
            const referrerQuery = await pgPool.query(
                `SELECT user_id, full_name FROM client WHERE ref_code = $1 LIMIT 1`,
                [startParam]
            );
            
            if (referrerQuery.rows.length > 0) {
                referrerId = referrerQuery.rows[0].user_id;
                console.log(`🎉 Найден пригласивший: ${referrerQuery.rows[0].full_name} (${referrerId})`);
            }
        } catch (err) {
            console.error('Ошибка поиска реферала:', err.message);
        }
    }

    const isAuthorized = await checkClientExists(userId);

    if (isAuthorized) {
        await ctx.reply(`👋 С возвращением, ${userName}!`);
        return true;
    }

    userStates.delete(userId);
    userStates.set(userId, { referrerId });

    await ctx.reply(
        `📄 В соответствии с Федеральным законом №152-ФЗ "О персональных данных",\n\n` +
        `вы должны дать согласие на обработку ваших данных для продолжения работы.\n\n` +
        `Нажимая "Согласен", вы подтверждаете, что ознакомлены и согласны с условиями.`,
        { attachments: [agreeKeyboard] }
    );
    
    return false;
}

// Получение userId из разных типов событий
function getUserIdFromContext(ctx) {
    return ctx.user_id || 
           ctx.user?.user_id || 
           ctx.message?.sender?.user_id || 
           ctx.callback?.user?.user_id;
}

function handleStart(bot) {
    // Обработчик запуска через интерфейс MAX
    bot.on('bot_started', async (ctx) => {
        const userId = getUserIdFromContext(ctx);
        const userName = ctx.user?.first_name || ctx.message?.sender?.first_name || 'Гость';
        const startParam = ctx.start_param || ctx.message?.body?.start_param;
        
        await authorizeUser(ctx, userId, userName, startParam);
    });

    // Обработчик команды /start
    bot.command('start', async (ctx) => {
        const userId = getUserIdFromContext(ctx);
        const userName = ctx.message?.sender?.first_name || 'Гость';
        
        // Извлекаем start_param из текста "/start КОД"
        let startParam = ctx.message?.body?.start_param;
        const fullText = ctx.message?.body?.text || '';
        
        if (!startParam && fullText.startsWith('/start ')) {
            startParam = fullText.substring(7).trim();
        }
        
        await authorizeUser(ctx, userId, userName, startParam);
    });
}

function handleAgreeProcessing(bot) {
    bot.action('agree_processing', async (ctx) => {
        const userId = ctx.callback?.user?.user_id;
        const state = userStates.get(userId) || {};
        
        console.log('✅ Согласие получено от пользователя:', userId);
        userStates.set(userId, { 
            step: 'awaiting_phone',
            referrerId: state.referrerId 
        });
        console.log('📝 Состояние сохранено:', userStates.get(userId));

        await ctx.reply(
            '📱 Для продолжения работы, пожалуйста, поделитесь своим номером телефона:',
            { attachments: [requestContactKeyboard] }
        );
    });
}

function handleContact(bot) {
    bot.on('message_created', async (ctx) => {
        const message = ctx.message;
        const userId = message?.sender?.user_id;
        const state = userStates.get(userId);

        console.log('🔍 userId:', userId);
        console.log('🔍 state:', state);

        if (!state || state.step !== 'awaiting_phone') {
            console.log('⏭️ Пропускаем: нет состояния или не тот шаг');
            return;
        }

        const attachments = message?.body?.attachments || [];
        const contactAttachment = attachments.find(a => a.type === 'contact');

        if (!contactAttachment) {
            console.log('❌ Контакт не найден в attachments');
            return;
        }

        const contact = contactAttachment.payload;
        const phone = contact?.vcf_info?.match(/TEL[^:]*:([^\r\n]+)/)?.[1];

        console.log('📞 Найден номер телефона:', phone);

        if (phone) {
            await ctx.reply('🔍 Проверяем данные пациента...');

            const result = await getClientByPhone(phone);
            console.log('📦 Результат API:', JSON.stringify(result, null, 2));

            if (result.success && result.client) {
                const client = result.client;
                const hasVip = client.branches?.some(b => b.name === 'VIP');

                let messageText = `📋 Найдены ваши данные:\n\n` +
                    `👤 ФИО: ${client.display_name || 'Не указано'}\n` +
                    `🎂 Дата рождения: ${client.birthday || 'Не указана'}\n` +
                    `📞 Телефон: ${client.value || phone}\n`;

                if (hasVip) messageText += `👑 Статус: VIP\n`;
                messageText += `\n✅ Подтверждаете, что это ваши данные?`;

                userStates.set(userId, {
                    step: 'awaiting_confirm',
                    clientData: client,
                    phone: phone,
                    referrerId: state.referrerId
                });

                await ctx.reply(messageText, { attachments: [confirmKeyboard] });
            } else {
                await ctx.reply(`❌ Пациент с номером ${phone} не найден\n\nОбратитесь в клинику.`);
                userStates.delete(userId);
            }
        } else {
            await ctx.reply('❌ Не удалось извлечь номер телефона из контакта');
        }
    });
}

function handleConfirmData(bot) {
    bot.action('confirm_data', async (ctx) => {
        const userId = ctx.callback?.user?.user_id;
        const state = userStates.get(userId);

        if (!state || state.step !== 'awaiting_confirm') {
            await ctx.reply('❌ Сессия истекла. Нажмите /start');
            return;
        }

        const result = await saveClientToDB(userId, state.clientData, state.phone, state.referrerId);

        if (result) {
            console.log(`✅ Клиент сохранен: ${userId}, пригласил: ${state.referrerId || 'никто'}`);
        }

        userStates.delete(userId);

        await ctx.reply(
            `✅ Добро пожаловать!\n\nВы успешно авторизованы.`
        );
    });
}

function handleCancelAuth(bot) {
    bot.action('cancel_auth', async (ctx) => {
        const userId = ctx.callback?.user?.user_id;
        userStates.delete(userId);
        await ctx.reply(`❌ Авторизация отменена\n\nНажмите /start для повторной попытки.`);
    });
}

module.exports = {
    handleStart,
    handleAgreeProcessing,
    handleContact,
    handleConfirmData,
    handleCancelAuth,
    userStates
};