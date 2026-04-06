const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const dayjs = require('dayjs');

// Конфигурация бота
const BOT_TOKEN = '7191091641:AAEHWDOqTSOnIu1ZTpadmBkialDbW2etRqQ';
const bot = new Telegraf(BOT_TOKEN);

// Конфигурация базы данных
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: '32karata',
    password: '5600119kj;rf',
    port: 5433,
});

// API параметры
const API_TOKEN = 'ff66ef3e-0ffb-49b5-a7c7-2b7659ae2a1e';
const API_SECRET = '9e27bda7406bf9f79154dbd8fc5d3a8c';
const API_URL = 'https://32karatatlt.dental-pro.online/api/mobile/schedule';
const API_CLIENT_URL = 'https://32karatatlt.dental-pro.online/api/client_by_phone';

// Хранилище состояний пользователей
const userStates = new Map();

// Функция генерации уникального кода
async function generateUniqueCode() {
    let code;
    let exists = true;

    while (exists) {
        code = Math.floor(100000 + Math.random() * 900000).toString();
        const result = await pool.query(
            `SELECT user_id FROM public.client WHERE client_code = $1 OR ref_code = $1`,
            [code]
        );
        exists = result.rows.length > 0;
    }

    return code;
}

// Функция очистки номера телефона
function cleanPhoneNumber(phone) {
    let cleaned = String(phone).replace(/[^\d]/g, '');
    if (cleaned.startsWith('8')) {
        cleaned = '7' + cleaned.slice(1);
    }
   
    return cleaned;
}

// Функция запроса к API для получения данных клиента
async function getClientByPhone(phone) {
    const cleanPhone = cleanPhoneNumber(phone);
    const url = `${API_CLIENT_URL}?token=${API_TOKEN}&secret=${API_SECRET}&phone=${cleanPhone}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.status && data.data && Object.keys(data.data).length > 0) {
            const clientKey = Object.keys(data.data)[0];
            const client = data.data[clientKey];
            console.log('🔍 getClientByPhone: client =', JSON.stringify(client, null, 2));
            console.log('🔍 getClientByPhone: id_client =', client.id_client);
            console.log('🔍 getClientByPhone: display_name =', client.display_name);
            return { success: true, client };
        }
        return { success: false, error: 'Пациент не найден' };
    } catch (error) {
        console.error('Ошибка API:', error);
        return { success: false, error: 'Ошибка соединения' };
    }
}

async function saveClientToDB(userId, clientData, phone) {
    const clientCode = await generateUniqueCode();
    const refCode = await generateUniqueCode();
    
    console.log('🔍 saveClientToDB: clientData =', JSON.stringify(clientData, null, 2));
    console.log('🔍 saveClientToDB: clientData.id_client =', clientData.id_client);
    
    // Правильное поле - id_client, а не id_client (оно есть в ответе API)
    const clinicPersonId = clientData.id_client ? Number(clientData.id_client) : null;
    console.log('🔍 saveClientToDB: clinicPersonId =', clinicPersonId);
    
    const query = `
        INSERT INTO public.client (
            user_id, full_name, phone, birth_date, reg_date, role, 
            client_code, ref_code, is_new, bonus_balance, clinic_person_id, data_processing
        ) VALUES ($1, $2, $3, $4, NOW(), 'patient', $5, $6, true, 200, $7, true)
        ON CONFLICT (user_id) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            phone = EXCLUDED.phone,
            birth_date = EXCLUDED.birth_date,
            clinic_person_id = EXCLUDED.clinic_person_id,
            data_processing = true
        RETURNING *;
    `;
    
    const numericUserId = Number(userId);
    
    const values = [
        numericUserId,
        clientData.display_name || null,
        phone,
        clientData.birthday || null,
        clientCode,
        refCode,
        clinicPersonId  // Используем правильную переменную
    ];
    
    console.log('🔍 saveClientToDB: values =', values);
    
    try {
        const result = await pool.query(query, values);
        console.log(`✅ Клиент сохранен в БД: ${userId} - ${clientData.display_name}`);
        return result.rows[0];
    } catch (error) {
        console.error('Ошибка сохранения клиента:', error);
        return null;
    }
}

// Функция для нормализации ФИО
function normalizePatientName(shortName) {
    const parts = shortName.split(' ');
    if (parts.length < 2) return null;

    const lastName = parts[0];
    const firstInitial = parts[1]?.charAt(0);
    const middleInitial = parts[1]?.charAt(2);

    if (!firstInitial) return null;

    return { lastName, firstInitial, middleInitial };
}

// Функция поиска пациента в БД
async function findPatientByName(shortName) {
    const normalized = normalizePatientName(shortName);
    if (!normalized) return null;

    const { lastName, firstInitial, middleInitial } = normalized;

    const query = `
        SELECT user_id, full_name, phone
        FROM public.client 
        WHERE full_name ILIKE $1 AND data_processing = true
    `;

    const result = await pool.query(query, [`${lastName}%`]);

    for (const patient of result.rows) {
        const fullName = patient.full_name;
        const nameParts = fullName.split(' ');
        if (nameParts.length >= 2) {
            const firstName = nameParts[1];
            if (firstName && firstName.charAt(0).toUpperCase() === firstInitial.toUpperCase()) {
                if (middleInitial && nameParts.length >= 3) {
                    const middleName = nameParts[2];
                    if (middleName && middleName.charAt(0).toUpperCase() === middleInitial.toUpperCase()) {
                        return patient;
                    }
                } else if (!middleInitial) {
                    return patient;
                }
            }
        }
    }

    return null;
}

// Функция получения расписания из API
async function getSchedule(dateStart, dateEnd) {
    const url = `${API_URL}?token=${API_TOKEN}&secret=${API_SECRET}&date_start=${dateStart}&date_end=${dateEnd}`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        return data.data || [];
    } catch (error) {
        console.error('Ошибка получения расписания:', error);
        return [];
    }
}

// Функция создания записи в reminders
async function createReminder(userId, scheduleId, kind, messageId, chatId) {
    const query = `
        INSERT INTO reminders (user_id, schedid, kind, sent_at, is_active, message_id, chat_id)
        VALUES ($1, $2, $3, NOW(), true, $4, $5)
        RETURNING id
    `;

    const result = await pool.query(query, [userId, scheduleId, kind, messageId, chatId]);
    return result.rows[0].id;
}

// Функция обновления статуса подтверждения
async function updateReminderAck(reminderId, userId) {
    const query = `
        UPDATE reminders 
        SET ack_at = NOW(), ack_by = $1, is_active = false
        WHERE id = $2
    `;

    await pool.query(query, [userId, reminderId]);
}

// Функция отправки напоминания
async function sendReminder(chatId, patient, doctorName, appointmentDate, kind, scheduleId) {
    const date = dayjs(appointmentDate).format('DD.MM.YYYY');
    const hours = dayjs(appointmentDate).hour();
    const minutes = dayjs(appointmentDate).minute();

    let message = '';

    if (kind === '1d') {
        message = `⏰ *Напоминание!*\n` +
            `Завтра у вас приём у врача\n` +
            `🗓 Дата: ${date}\n` +
            `👨🏻‍⚕️ Врач: ${doctorName}\n` +
            `🕒 Время: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    } else if (kind === '3d') {
        message = `📅 *Предварительное напоминание*\n` +
            `Через 3 дня у вас приём у врача\n` +
            `🗓 Дата: ${date}\n` +
            `👨🏻‍⚕️ Врач: ${doctorName}\n` +
            `🕒 Время: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    }

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Подтверждаю', `confirm_reminder_${scheduleId}`)]
    ]);

    try {
        const sentMessage = await bot.telegram.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            ...keyboard
        });

        const reminderId = await createReminder(
            patient.user_id,
            scheduleId,
            kind,
            sentMessage.message_id,
            chatId
        );

        console.log(`📨 Отправлено напоминание (${kind}) пациенту ${patient.full_name} (${chatId})`);
        return reminderId;
    } catch (error) {
        console.error(`Ошибка отправки сообщения пациенту ${chatId}:`, error.message);
        return null;
    }
}

// Функция проверки и отправки напоминаний
async function checkAndSendReminders() {
    const today = dayjs().format('YYYY-MM-DD');
    const dateEnd = dayjs().add(3, 'days').format('YYYY-MM-DD');

    console.log(`\n=== Проверка напоминаний за период ${today} - ${dateEnd} ===\n`);

    const schedule = await getSchedule(today, dateEnd);

    if (!schedule || schedule.length === 0) {
        console.log('Нет данных о записях');
        return;
    }

    for (const doctor of schedule) {
        const doctorName = doctor.title;
        const tasks = doctor.tasks || [];

        for (const task of tasks) {
            if (task.title === 'Резерв' || task.title.includes('Медсестра')) {
                continue;
            }

            const patientShortName = task.title;
            const appointmentDate = task.date_start;
            const scheduleId = task.id;

            const existingReminder = await pool.query(
                `SELECT id, kind, is_active FROM reminders 
                 WHERE schedid = $1 AND is_active = true`,
                [scheduleId]
            );

            if (existingReminder.rows.length > 0) {
                console.log(`⏭️ Напоминание для записи ${scheduleId} уже отправлено`);
                continue;
            }

            const patient = await findPatientByName(patientShortName);
            if (!patient) {
                console.log(`❌ Пациент не найден: ${patientShortName}`);
                continue;
            }

            const appointmentDayjs = dayjs(appointmentDate);
            const today = dayjs().startOf('day');
            const appointmentDay = appointmentDayjs.startOf('day');
            const daysDiff = appointmentDay.diff(today, 'day');
            const chatId = patient.user_id;

            console.log(`📝 Запись: ${patientShortName}, дата: ${appointmentDate}, дней до: ${daysDiff}`);

            if (daysDiff === 3) {
                await sendReminder(chatId, patient, doctorName, appointmentDate, '3d', scheduleId);
            } else if (daysDiff === 1) {
                await sendReminder(chatId, patient, doctorName, appointmentDate, '1d', scheduleId);
            }
        }
    }

    console.log('=== Проверка завершена ===\n');
}

// Обработчик кнопки подтверждения напоминания
bot.action(/confirm_reminder_(.+)/, async (ctx) => {
     await ctx.answerCbQuery();
    const scheduleId = ctx.match[1];
    const userId = ctx.from.id;
    const userName = ctx.from.first_name;

    console.log(`✅ Пользователь ${userName} (${userId}) подтвердил запись ${scheduleId}`);

    try {
        const reminder = await pool.query(
            `SELECT id, user_id FROM reminders 
             WHERE schedid = $1 AND is_active = true`,
            [scheduleId]
        );

        if (reminder.rows.length === 0) {
            await ctx.answerCbQuery('❌ Напоминание не найдено или уже обработано');
            return;
        }

        const reminderId = reminder.rows[0].id;
        await updateReminderAck(reminderId, userId);

        await ctx.answerCbQuery('✅ Спасибо! Ваше подтверждение получено.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });

    } catch (error) {
        console.error('Ошибка при подтверждении:', error);
        await ctx.answerCbQuery('❌ Произошла ошибка, попробуйте позже');
    }
});

// Обработчик согласия на обработку данных
bot.action('agree_processing', async (ctx) => {
     await ctx.answerCbQuery();
    const userId = ctx.from.id;

    userStates.set(userId, { step: 'awaiting_phone' });

    const keyboard = {
        reply_markup: {
            keyboard: [[{ text: '📞 Отправить номер телефона', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true
        }
    };

    await ctx.reply(
        '📱 Для продолжения работы, пожалуйста, поделитесь своим номером телефона.\n\n' +
        'Нажмите на кнопку ниже:',
        keyboard
    );
});

// Обработчик подтверждения данных клиента
bot.action('confirm_client', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        
        const userId = ctx.from.id;
        console.log(`🔍 confirm_client: userId = ${userId}, тип = ${typeof userId}`);
        
        const state = userStates.get(userId);
        console.log(`🔍 confirm_client: state =`, state);

        if (!state || !state.clientData) {
            await ctx.reply('❌ Сессия истекла. Нажмите /start для повторной авторизации.');
            return;
        }

        const { clientData, phone } = state;
        console.log(`🔍 confirm_client: clientData =`, clientData);
        console.log(`🔍 confirm_client: phone = ${phone}`);

        // Сохраняем клиента в БД
        const savedClient = await saveClientToDB(userId, clientData, phone);
        console.log(`🔍 confirm_client: savedClient =`, savedClient);

        userStates.delete(userId);

        await ctx.reply(
            `✅ *Добро пожаловать, ${clientData.name || clientData.display_name || 'гость'}!*\n\n` +
            `Вы успешно прошли авторизацию в боте.\n\n` +
            `Теперь вам доступны все функции бота.\n\n` +
            `Используйте команду /check для проверки записей.`,
            { parse_mode: 'Markdown' }
        );
    } catch (error) {
        console.error('Ошибка в confirm_client:', error);
        await ctx.reply('❌ Произошла ошибка при подтверждении. Попробуйте позже.');
    }
});

// Обработчик отмены
bot.action('cancel_auth', async (ctx) => {
    const userId = ctx.from.id;

    userStates.delete(userId);

    await ctx.reply(
        `❌ *Авторизация отменена*\n\n` +
        `Если вы ошиблись, нажмите /start и попробуйте снова.`,
        { parse_mode: 'Markdown' }
    );
});

// Обработчик получения контакта
bot.on('contact', async (ctx) => {

    const userId = ctx.from.id;
    const state = userStates.get(userId);
    const contact = ctx.message.contact;

    if (!state || state.step !== 'awaiting_phone') {
        return;
    }

    if (!contact || !contact.phone_number) {
        await ctx.reply('❌ Не удалось получить номер телефона. Попробуйте еще раз.');
        return;
    }

    const phone = contact.phone_number;
    const cleanPhone = cleanPhoneNumber(phone);

    await ctx.reply('🔍 Проверяем данные пациента...');

    const result = await getClientByPhone(cleanPhone);

    if (result.success && result.client) {
        const client = result.client;

        const hasVip = client.branches?.some(b => b.name === 'VIP');

        let messageText = `📋 *Найдены ваши данные:*\n\n` +
            `👤 *ФИО:* ${client.display_name || 'Не указано'}\n` +
            `🎂 *Дата рождения:* ${client.birthday || 'Не указана'}\n` +
            `📞 *Телефон:* ${client.value || cleanPhone}\n`;

        if (hasVip) {
            messageText += `👑 *Статус:* VIP\n`;
        }

        messageText += `\n✅ *Подтверждаете, что это ваши данные?*`;

        const confirmKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('✅ Да, это я', 'confirm_client')],
            [Markup.button.callback('❌ Нет, отменить', 'cancel_auth')]
        ]);

        userStates.set(userId, {
            step: 'awaiting_confirm',
            clientData: client,
            phone: cleanPhone
        });

        await ctx.reply(messageText, { parse_mode: 'Markdown', ...confirmKeyboard });

    } else {
        await ctx.reply(
            `❌ *Пациент с номером ${cleanPhone} не найден в базе данных*\n\n` +
            `Пожалуйста, обратитесь в клинику для регистрации или проверьте правильность номера телефона.\n\n` +
            `Нажмите /start для повторной попытки.`,
            { parse_mode: 'Markdown' }
        );

        userStates.delete(userId);
    }
});

// Команда /start
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name;

    console.log(`👤 Пользователь ${userName} (${userId}) запустил бота`);

    // Проверяем, авторизован ли пользователь
    const existingUser = await pool.query(
    `SELECT user_id, full_name, data_processing FROM public.client WHERE user_id = $1`,
    [Number(userId)]  
);

    if (existingUser.rows.length > 0 && existingUser.rows[0].data_processing === true) {
        // Пользователь уже авторизован
        await ctx.reply(
            `👋 С возвращением, ${userName}!\n\n` +
            `Вы уже авторизованы в боте.\n\n` +
            `Доступные команды:\n` +
            `/check - проверить записи и отправить напоминания\n` +
            `/help - помощь`
        );
        return;
    }

    // Запрашиваем согласие на обработку данных
    const agreeKeyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Согласен', 'agree_processing')],
        [Markup.button.callback('❌ Не согласен', 'cancel_auth')]
    ]);

    await ctx.reply(
        `📄 *В соответствии с Федеральным законом №152-ФЗ "О персональных данных",*\n\n` +
        `вы должны дать согласие на обработку ваших данных для продолжения работы.\n\n` +
        `Ваши данные будут использоваться только для:\n` +
        `• отправки напоминаний о записях\n` +
        `• подтверждения визитов\n` +
        `• связи с клиникой\n\n` +
        `Нажимая "Согласен", вы подтверждаете, что ознакомлены и согласны с условиями.`,
        { parse_mode: 'Markdown', ...agreeKeyboard }
    );
});

// Команда /help
bot.help(async (ctx) => {
    await ctx.reply(
        `📋 *Справка по командам:*\n\n` +
        `/start - начать работу с ботом\n` +
        `/check - проверить записи и отправить напоминания за 1 и 3 дня\n` +
        `/help - показать это сообщение\n\n` +
        `При получении напоминания нажмите кнопку "Подтверждаю", чтобы подтвердить визит.\n\n` +
        `*Важно:* Для работы бота необходимо пройти авторизацию через номер телефона.`,
        { parse_mode: 'Markdown' }
    );
});

// Команда /check - ручной запуск проверки
bot.command('check', async (ctx) => {
    const userId = ctx.from.id;
    const userName = ctx.from.first_name;

    // Проверяем, авторизован ли пользователь
    const existingUser = await pool.query(
        `SELECT data_processing FROM public.client WHERE user_id = $1`,
        [userId]
    );

    if (existingUser.rows.length === 0 || existingUser.rows[0].data_processing !== true) {
        await ctx.reply(
            `❌ *Доступ запрещен*\n\n` +
            `Вы не прошли авторизацию. Нажмите /start для начала работы и подтверждения согласия на обработку данных.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    console.log(`🔍 Пользователь ${userName} запустил проверку вручную`);

    await ctx.reply('🔍 Начинаю проверку записей и отправку напоминаний...');

    try {
        await checkAndSendReminders();
        await ctx.reply('✅ Проверка завершена! Напоминания отправлены.');
    } catch (error) {
        console.error('Ошибка при проверке:', error);
        await ctx.reply('❌ Произошла ошибка при проверке');
    }
});

// Запуск бота
bot.launch().then(() => {
    console.log('🤖 Бот запущен!');
    console.log('📋 Доступные команды: /start, /check, /help');

    const scheduleDailyCheck = () => {
        const now = dayjs();
        const next9am = dayjs().hour(9).minute(0).second(0);
        const delay = next9am.diff(now);

        if (delay > 0) {
            setTimeout(() => {
                console.log('⏰ Запуск ежедневной проверки напоминаний...');
                checkAndSendReminders();
                // Запускаем следующий цикл
                setInterval(() => {
                    console.log('⏰ Запуск ежедневной проверки напоминаний...');
                    checkAndSendReminders();
                }, 24 * 60 * 60 * 1000);
            }, delay);
        } else {
            // Если уже прошло 9 утра, запускаем завтра
            const tomorrow9am = dayjs().add(1, 'day').hour(9).minute(0).second(0);
            const delayToTomorrow = tomorrow9am.diff(now);
            setTimeout(() => {
                console.log('⏰ Запуск ежедневной проверки напоминаний...');
                checkAndSendReminders();
                setInterval(() => {
                    console.log('⏰ Запуск ежедневной проверки напоминаний...');
                    checkAndSendReminders();
                }, 24 * 60 * 60 * 1000);
            }, delayToTomorrow);
        }
    };

    scheduleDailyCheck();
});

// Обработка graceful shutdown
process.once('SIGINT', () => {
    console.log('🛑 Останавливаем бота...');
    bot.stop('SIGINT');
    pool.end();
});
process.once('SIGTERM', () => {
    console.log('🛑 Останавливаем бота...');
    bot.stop('SIGTERM');
    pool.end();
});

// Проверка подключения к БД
pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Ошибка подключения к БД:', err.message);
    } else {
        console.log('✅ Подключение к БД успешно установлено');
        release();
    }
});