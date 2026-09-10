// handlers/authHandlers.js
const { getClientByPhone, checkClientExists, saveClientToDB } = require('../services/clientService');
const { requestContactKeyboard, confirmKeyboard, agreeKeyboard } = require('../keyboards/keyboards');
const { cleanPhoneNumber } = require('../utils/phoneHelper');
const { pool } = require('../db');
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


async function resolveReferrerId(startParam) {
    if (!startParam) return null;

    // Убираем префикс "ref_", если есть
    const refCode = startParam.startsWith('ref_')
        ? startParam.replace('ref_', '')
        : startParam;

    console.log(`🔍 Поиск реферера по ref_code: ${refCode}`);

    try {
        const result = await pool.query(
            `SELECT id FROM client WHERE ref_code = $1 LIMIT 1`,
            [refCode]
        );

        if (result.rows.length > 0) {
            const referrerId = result.rows[0].id;
            console.log(`✅ Referrer ID (client.id): ${referrerId}`);
            return referrerId;
        }

        console.log(`⚠️ Реферер не найден по ref_code: ${refCode}`);
        return null;

    } catch (error) {
        console.error('❌ Ошибка поиска реферера:', error.message);
        return null;
    }
}

// Основная функция авторизации
async function authorizeUser(ctx, userId, userName, startParam, avatarUrl) {
    console.log(new Date().toISOString(), 'Авторизация пользователя:', userId, userName, 'avatar:', avatarUrl);

    if (!userId) {
        console.error('❌ Не удалось получить userId');
        await ctx.reply('Ошибка авторизации. Пожалуйста, попробуйте позже.');
        return false;
    }

    // ✅ Ищем id из таблицы client по ref_code (как в Telegram)
    const referrerId = await resolveReferrerId(startParam);

    if (referrerId) {
        console.log(`🎉 Referrer ID (client.id): ${referrerId}`);
    } else {
        console.log('ℹ️ Реферальный код не указан или не найден');
    }

    // Очищаем старый стейт пользователя
    userStates.delete(userId);
    
    userStates.set(userId, {
        referrerId,  // ← id из таблицы client
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

function getStartParamFromContext(ctx) {
    const sources = [
        ctx.payload,
        ctx.update?.payload,
        ctx.message?.body?.payload,
        ctx.start_param,
        ctx.update?.start_param,
        ctx.message?.body?.start_param,
        ctx.event?.payload,
        ctx.event?.start_param,
    ];

    for (const source of sources) {
        if (source !== undefined && source !== null && source !== '') {
            console.log('✅ startParam найден:', source);
            return String(source);
        }
    }

    const fullText = ctx.message?.body?.text || '';
    if (fullText.startsWith('/start ')) {
        return fullText.substring(7).trim();
    }

    console.log('⚠️ startParam не найден. Доступные поля:', {
        'ctx.payload': ctx.payload,
        'ctx.update?.payload': ctx.update?.payload,
        'ctx.message?.body?.payload': ctx.message?.body?.payload,
        'ctx.start_param': ctx.start_param,
        'ctx.update?.start_param': ctx.update?.start_param,
        'ctx.message?.body?.start_param': ctx.message?.body?.start_param,
        'ctx.event?.payload': ctx.event?.payload,
        'ctx.message?.body?.text': ctx.message?.body?.text,
    });

    return null;
}

function handleStart(bot) {
    bot.on('bot_started', async (ctx) => {
        const userId = getUserIdFromContext(ctx);
        const userName = ctx.user?.first_name || ctx.message?.sender?.first_name || 'Гость';
        const avatarUrl = getAvatarUrlFromContext(ctx);
        const startParam = getStartParamFromContext(ctx);

        console.log('📱 bot_started:', { userId, userName, avatarUrl, startParam });

        await authorizeUser(ctx, userId, userName, startParam, avatarUrl);
    });

    bot.command('start', async (ctx) => {
        const userId = getUserIdFromContext(ctx);
        const userName = ctx.message?.sender?.first_name || 'Гость';
        const avatarUrl = getAvatarUrlFromContext(ctx);
        const startParam = getStartParamFromContext(ctx);

        console.log('📱 /start command:', { userId, userName, avatarUrl, startParam });

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
            referrerId: existingState.referrerId,  // ← сохраняем referrerId
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
        const referrerId = state.referrerId;  // ← id из таблицы client

        console.log('🔗 Сохранение клиента:', {
            userId,
            referrerId,  // ← логируем для проверки
            phone,
            platform: 'max'
        });

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
    userStates,
    resolveReferrerId  // ← экспортируем для тестов
};