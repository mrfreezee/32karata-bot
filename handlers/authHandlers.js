// handlers/authHandlers.js
const { getClientByPhone, checkClientExists, saveClientToDB } = require('../services/clientService');
const { requestContactKeyboard, confirmKeyboard, agreeKeyboard } = require('../keyboards/keyboards');
const logger = require('../services/loggerService');
const { cleanPhoneNumber } = require('../utils/phoneHelper'); // ДОБАВИТЬ ИМПОРТ

const userStates = new Map();

function handleStart(bot) {
    bot.command('start', async (ctx) => {
        const startParam = ctx.message?.body?.start_param;
        console.log('🔍 start_param:', startParam);

        const userId = ctx.message?.sender?.user_id;
        const userName = ctx.message?.sender?.first_name || 'Гость';

        logger.botStart(userId, userName, startParam);

        console.log(new Date().toISOString(), 'Пользователь запустил бота:', userId, userName);

        let finalUserId = userId;
        if (startParam) {
            finalUserId = startParam;
        }

        const isAuthorized = await checkClientExists(finalUserId);

        if (isAuthorized) {
            await ctx.reply(
                `👋 С возвращением, ${userName}!\n\nВы уже авторизованы в боте.`
            );
            return;
        }

        userStates.delete(userId);

        await ctx.reply(
            `📄 В соответствии с Федеральным законом №152-ФЗ "О персональных данных",\n\n` +
            `вы должны дать согласие на обработку ваших данных для продолжения работы.\n\n` +
            `Нажимая "Согласен", вы подтверждаете, что ознакомлены и согласны с условиями.`,
            { attachments: [agreeKeyboard] }
        );
    });
}

function handleAgreeProcessing(bot) {
    bot.action('agree_processing', async (ctx) => {
        const userId = ctx.callback?.user?.user_id;
        logger.consentGiven(userId);
        console.log('✅ Согласие получено от пользователя:', userId);
        userStates.set(userId, { step: 'awaiting_phone' });
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
        const userId = message?.sender?.user_id; // userId отправителя
        const state = userStates.get(userId);

        console.log('🔍 userId:', userId);
        console.log('🔍 state:', state);
        console.log('🔍 Все состояния:', Array.from(userStates.entries()));

        // Проверяем состояние
        if (!state || state.step !== 'awaiting_phone') {
            console.log('⏭️ Пропускаем: нет состояния или не тот шаг');
            return;
        }

        // Ищем контакт в attachments
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
                    phone: phone
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

        const result = await saveClientToDB(userId, state.clientData, state.phone);

        if (result) {
            logger.authSuccess(userId, state.phone, state.clientData);
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
         logger.authCancel(userId)
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