// handlers/authHandlers.js
const { getClientByPhone, checkClientExists, saveClientToDB } = require('../services/clientService');
const { requestContactKeyboard, confirmKeyboard, agreeKeyboard } = require('../keyboards/keyboards');
const { cleanPhoneNumber } = require('../utils/phoneHelper');
const { pgPool } = require('../db');
const { Keyboard } = require('@maxhub/max-bot-api');

const userStates = new Map();

// Получение userId из разных типов событий
function getUserIdFromContext(ctx) {
    return ctx.user_id ||
        ctx.user?.user_id ||
        ctx.message?.sender?.user_id ||
        ctx.callback?.user?.user_id;
}

// Получение avatarUrl из контекста
function getAvatarUrlFromContext(ctx) {
    return ctx.user?.avatar_url || ctx.user?.full_avatar_url || null;
}

// Основная функция авторизации
async function authorizeUser(ctx, userId, userName, startParam, avatarUrl) {
    console.log(new Date().toISOString(), 'Авторизация пользователя:', userId, userName, 'avatar:', avatarUrl);

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
        await ctx.reply(`👋 С возвращением, ${userName}!\n\nДля использования приложения нажмите кнопку Открыть в левом нижнем углу чата.`);
        return true;
    }

    userStates.delete(userId);
    userStates.set(userId, {
        referrerId,
        avatarUrl,
        step: 'start'
    });

    await ctx.reply(
        `📄 В соответствии с Федеральным законом №152-ФЗ "О персональных данных",\n\n` +
        `вы должны дать согласие на обработку ваших данных для продолжения работы.\n\n` +
        `Нажимая "Согласен", вы подтверждаете, что ознакомлены и согласны с условиями.`,
        { attachments: [agreeKeyboard] }
    );

    return false;
}

function handleStart(bot) {
    bot.on('bot_started', async (ctx) => {
        const userId = getUserIdFromContext(ctx);
        const userName = ctx.user?.first_name || ctx.message?.sender?.first_name || 'Гость';
        const startParam = ctx.start_param || ctx.message?.body?.start_param;
        const avatarUrl = getAvatarUrlFromContext(ctx);

        console.log('📱 bot_started:', { userId, userName, avatarUrl });

        await authorizeUser(ctx, userId, userName, startParam, avatarUrl);
    });

    bot.command('start', async (ctx) => {
        const userId = getUserIdFromContext(ctx);
        const userName = ctx.message?.sender?.first_name || 'Гость';
        const avatarUrl = getAvatarUrlFromContext(ctx);

        console.log('📱 /start command:', { userId, userName, avatarUrl });

        let startParam = ctx.message?.body?.start_param;
        const fullText = ctx.message?.body?.text || '';

        if (!startParam && fullText.startsWith('/start ')) {
            startParam = fullText.substring(7).trim();
        }

        await authorizeUser(ctx, userId, userName, startParam, avatarUrl);
    });
}

function handleAgreeProcessing(bot) {
    bot.action('agree_processing', async (ctx) => {
        const userId = ctx.callback?.user?.user_id;
        const existingState = userStates.get(userId) || {};

        console.log('✅ Согласие получено от пользователя:', userId);
        console.log('📦 existingState:', existingState);

        userStates.set(userId, {
            step: 'awaiting_phone',
            referrerId: existingState.referrerId,
            avatarUrl: existingState.avatarUrl
        });

        console.log('📝 Новое состояние:', userStates.get(userId));

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
        console.log('📨 message_created:', {
            hasText: !!ctx.message?.body?.text,
            text: ctx.message?.body?.text,
            attachments: ctx.message?.body?.attachments?.map(a => a.type)
        });

        if (!state || state.step !== 'awaiting_phone') {
            console.log('⏭️ Пропускаем: нет состояния или не тот шаг');
            return;
        }

        const attachments = message?.body?.attachments || [];
        const contactAttachment = attachments.find(a => a.type === 'contact');

        if (!contactAttachment) {
            console.log('⏭️ Пропускаем: нет контакта');
            return;
        }

        // Защита от повторной обработки
        if (state._processingContact) {
            console.log('⏭️ Пропускаем дубль контакта');
            return;
        }

        // Ставим флаг обработки
        userStates.set(userId, { ...state, _processingContact: true });

        const contact = contactAttachment.payload;
        const phone = contact?.vcf_info?.match(/TEL[^:]*:([^\r\n]+)/)?.[1];

        if (!phone) {
            await ctx.reply('❌ Не удалось извлечь номер телефона');
            userStates.set(userId, { ...state, _processingContact: false });
            return;
        }

        await ctx.reply('🔍 Ищем пациентов...');

        try {
            const result = await getClientByPhone(phone);

            if (!result.success || !result.clients?.length) {
                await ctx.reply(`❌ Пациенты с номером ${phone} не найдены.\nОбратитесь в клинику.`);
                userStates.delete(userId);
                return;
            }

            const clients = result.clients;

            if (clients.length === 1) {
                const client = clients[0];
                userStates.set(userId, {
                    ...state,
                    step: 'awaiting_confirm',
                    clientData: client,
                    phone: phone,
                    _processingContact: false
                });

                const hasVip = client.branches?.some(b => b.name === 'VIP');
                let msg = `📋 Найдены ваши данные:\n\n` +
                    `👤 ФИО: ${client.display_name || 'Не указано'}\n` +
                    `🎂 Дата рождения: ${client.birthday || 'Не указана'}\n` +
                    `📞 Телефон: ${client.value || phone}\n`;
                if (hasVip) msg += `👑 Статус: VIP\n`;
                msg += `\n✅ Подтверждаете, что это ваши данные?`;

                await ctx.reply(msg, { attachments: [confirmKeyboard] });
                return;
            }

            // Несколько пациентов
            userStates.set(userId, {
                ...state,
                step: 'selecting_patient',
                phone: phone,
                allClients: clients,
                _processingContact: false
            });

            const buttons = clients.map((c, i) => [
                Keyboard.button.callback(
                    `${i + 1}. ${c.display_name || 'Без имени'} (${c.birthday || '—'})`,
                    `select_client_${i}`
                )
            ]);

            const selectKeyboard = Keyboard.inlineKeyboard(buttons);


            await ctx.reply(`📋 Найдено ${clients.length} пациента. Выберите основного:`, 
    { attachments: [selectKeyboard] }
);
        } catch (err) {
            console.error('Ошибка обработки контакта:', err);
            userStates.set(userId, { ...state, _processingContact: false });
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

        const avatarUrl = state.avatarUrl;
        const clientData = state.clientData;
        const phone = state.phone;
        const referrerId = state.referrerId;

        // Сохраняем выбранного пациента как основного
        await saveClientToDB(userId, clientData, phone, 'max', referrerId, avatarUrl);

        // Сохраняем остальных пациентов с тем же номером
        if (state.allClients && state.allClients.length > 1) {
            for (const c of state.allClients) {
                if (c.id_client !== clientData.id_client) {
                    await saveClientToDB(userId, c, phone, 'max', referrerId, avatarUrl);
                }
            }
        }

        userStates.delete(userId);
        await ctx.reply(`✅ Добро пожаловать!\n\nВы успешно авторизованы.\n\nДля использования приложения нажмите кнопку Открыть в левом нижнем углу чата.`);
    });
}

function handleCancelAuth(bot) {
    bot.action('cancel_auth', async (ctx) => {
        const userId = ctx.callback?.user?.user_id;
        userStates.delete(userId);
        await ctx.reply(`❌ Авторизация отменена\n\nНажмите /start для повторной попытки.`);
    });
}

function handleSelectClient(bot) {
    bot.action(/select_client_(\d+)/, async (ctx) => {
        const userId = ctx.callback?.user?.user_id;
        const state = userStates.get(userId);
        const index = parseInt(ctx.match[1]); // ← берем из регулярки

        if (!state || state.step !== 'selecting_patient') {
            await ctx.reply('❌ Сессия истекла. Нажмите /start');
            return;
        }

        const client = state.allClients[index];

        if (!client) {
            await ctx.reply('❌ Ошибка выбора');
            return;
        }

        userStates.set(userId, {
            ...state,
            step: 'awaiting_confirm',
            clientData: client
        });

        const hasVip = client.branches?.some(b => b.name === 'VIP');
        let msg = `📋 Найдены ваши данные:\n\n` +
            `👤 ФИО: ${client.display_name || 'Не указано'}\n` +
            `🎂 Дата рождения: ${client.birthday || 'Не указана'}\n` +
            `📞 Телефон: ${client.value || state.phone}\n`;
        if (hasVip) msg += `👑 Статус: VIP\n`;
        msg += `\n✅ Подтверждаете, что это ваши данные?`;

        await ctx.reply(msg, { attachments: [confirmKeyboard] });
    });
}

module.exports = {
    handleStart,
    handleAgreeProcessing,
    handleContact,
    handleConfirmData,
    handleCancelAuth,
    handleSelectClient,
    userStates
};