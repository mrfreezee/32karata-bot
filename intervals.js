// intervals.js (MAX версия)
const dayjs = require('dayjs');
const { Keyboard } = require('@maxhub/max-bot-api');
const { getUnsentBonuses, markBonusAsNotified, processPendingMailings, processPermanentReminders } = require('./services/clientService');
const { checkAndSendReminders } = require('./handlers/reminderHandlers');
const { medCorePool, pool } = require('./db');
const { shouldSkipDoctor } = require('./services/reviewService');

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:5005/api';
const API_CLIENT_URL = process.env.API_CLIENT_URL ? process.env.API_CLIENT_URL.replace(/\/$/, '') : '';
const API_TOKEN = process.env.API_TOKEN;
const API_SECRET = process.env.API_SECRET;
const LOCATION = process.env.LOCATION;

// Хранилище для отслеживания уже отправленных запросов
const sentReviews = new Map();

function startIntervals(bot) {

    // === Бонусы каждые 10 минут ===
    const bonusInterval = setInterval(async () => {
        const bonuses = await getUnsentBonuses();
        for (const bonus of bonuses) {
            const userId = bonus.max_id || bonus.max_id;
            if (!userId) continue;
            try {
                await bot.api.sendMessageToUser(userId,
                    `🎉 Вам начислены бонусы!\n💰 Сумма: ${bonus.bonus_amount}\n📅 Дата: ${new Date(bonus.bonus_processed_at).toLocaleDateString('ru-RU')}`
                );
                await markBonusAsNotified(bonus.id);
            } catch (err) {
                if (err.message.includes('chat not found') || err.message.includes('blocked')) {
                    await markBonusAsNotified(bonus.id, err.message);
                }
            }
        }
    }, 10 * 60 * 1000);

    // === Платежи каждую минуту ===
    const paymentInterval = setInterval(async () => {
        const payments = await medCorePool.query(
            `SELECT * FROM payments WHERE status = 'pending' AND clinic_id = 3 AND location = $1 LIMIT 10`,
            [LOCATION]
        );
        for (const payment of payments.rows) {
            if (!payment.max_id) continue;
            try {
                await bot.api.sendMessageToUser(payment.max_id,
                    `💳 Оплата услуг\nСумма: ${Number(payment.amount).toLocaleString()} ₽\nСсылка: ${payment.payment_url}`
                );
                await medCorePool.query(`UPDATE payments SET status = 'sent', sent_at = NOW() WHERE id = $1`, [payment.id]);
            } catch { }
            await new Promise(r => setTimeout(r, 1000));
        }
    }, 60 * 1000);

    // === НОВЫЙ ИНТЕРВАЛ: Проверка завершенных приемов и запрос отзывов (как в телеграме) ===
    const REVIEW_CHECK_INTERVAL = 30 * 60 * 1000; // каждые 30 минут

    const checkCompletedAppointments = async () => {
        console.log('🔍 Проверка завершенных приемов для запроса отзывов (MAX)...');

        try {
            const today = dayjs().format('YYYY-MM-DD');
            const url = `${API_CLIENT_URL}/api/mobile/schedule?token=${API_TOKEN}&secret=${API_SECRET}&date_start=${today}&date_end=${today}`;

            console.log('📡 URL запроса:', url);

            const response = await fetch(url);

            if (!response.ok) {
                console.log(`❌ Ошибка API: ${response.status}`);
                return;
            }

            const result = await response.json();
            const data = result?.data;

            if (!data || !Array.isArray(data)) {
                console.log('❌ Нет данных о расписании или неверный формат');
                return;
            }

            console.log(`✅ Получено ${data.length} врачей в расписании`);

            let sentCount = 0;

            for (const doctor of data) {
                if (shouldSkipDoctor(doctor.title, doctor.subtitle, doctor.tooltip)) {
                    console.log(`⏭️ Пропускаем врача: ${doctor.title} (${doctor.subtitle})`);
                    continue;
                }
                
                const doctorId = doctor.id;
                const doctorFullName = doctor.tooltip || doctor.title;

                // Получаем branch_id из блоков
                let branchId = null;
                const blocks = doctor.blocks || [];
                const infoBlock = blocks.find(block => block.type === 'info');
                
                if (infoBlock && infoBlock.branchID) {
                    branchId = infoBlock.branchID;
                    console.log(`   🏥 Найден branchId=${branchId} для врача ${doctorFullName}`);
                } else {
                    branchId = LOCATION === 'mosc' ? 50 : 3;
                    console.log(`   ⚠️ branchId не найден, используем default: ${branchId}`);
                }

                const tasks = doctor.tasks || [];

                for (const task of tasks) {
                    const patientID = task.patientID;
                    const taskDateStart = task.date_start;
                    const taskDateEnd = task.date_end;

                    if (!patientID) continue;

                    // Проверяем, закончился ли прием (прошло минимум 30 минут)
                    const endTime = dayjs(taskDateEnd);
                    const now = dayjs();
                    const minutesSinceEnd = now.diff(endTime, 'minute');

                    if (endTime.isAfter(now)) continue;
                    if (minutesSinceEnd < 30) continue;

                    const reviewKey = `${patientID}_${doctorId}_${taskDateStart}`;

                    // Очищаем старые ключи
                    const nowTime = Date.now();
                    for (const [key, time] of sentReviews.entries()) {
                        if (nowTime - time > 24 * 60 * 60 * 1000) {
                            sentReviews.delete(key);
                        }
                    }

                    if (sentReviews.has(reviewKey)) continue;

                    // Ищем клиента в БД по clinic_person_id (для MAX - max_id)
                    const clientResult = await pool.query(
                        `SELECT id, max_id, full_name, phone, clinic_person_id
                         FROM client 
                         WHERE clinic_person_id = $1 AND location = $2 AND max_id IS NOT NULL`,
                        [String(patientID), LOCATION]
                    );

                    if (!clientResult.rows.length) {
                        console.log(`❌ Клиент с patientID ${patientID} не найден (MAX)`);
                        continue;
                    }

                    const client = clientResult.rows[0];
                    const chatId = client.max_id;

                    if (!chatId) continue;

                    // Проверяем, не отправляли ли уже запрос на отзыв
                    const existingReview = await medCorePool.query(
                        `SELECT id FROM reviews 
                         WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3`,
                        [String(patientID), doctorId, taskDateStart]
                    );

                    if (existingReview.rows.length) {
                        sentReviews.set(reviewKey, Date.now());
                        continue;
                    }

                    const appointmentDate = dayjs(taskDateStart).format('DD.MM.YYYY');
                    const appointmentTime = dayjs(taskDateStart).format('HH:mm');

                    console.log(`✅ Отправляем запрос отзыва пациенту ${client.full_name} (MAX ID: ${chatId}), branchId=${branchId}`);

                    // Сохраняем контекст в БД с branch_id
                    await medCorePool.query(
                        `INSERT INTO pending_reviews (patient_id, doctor_id, doctor_name, appointment_date, branch_id, chat_id, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, NOW())
                         ON CONFLICT (patient_id, doctor_id, appointment_date) DO NOTHING`,
                        [String(patientID), doctorId, doctorFullName, taskDateStart, branchId, chatId]
                    );

                    // Создаем клавиатуру для MAX (кнопки в столбик)
                    const keyboard = Keyboard.buildInlineKeyboard([
                        [{ text: '⭐', callback_data: `review_1_${patientID}_${doctorId}_${taskDateStart}` }],
                        [{ text: '⭐⭐', callback_data: `review_2_${patientID}_${doctorId}_${taskDateStart}` }],
                        [{ text: '⭐⭐⭐', callback_data: `review_3_${patientID}_${doctorId}_${taskDateStart}` }],
                        [{ text: '⭐⭐⭐⭐', callback_data: `review_4_${patientID}_${doctorId}_${taskDateStart}` }],
                        [{ text: '⭐⭐⭐⭐⭐', callback_data: `review_5_${patientID}_${doctorId}_${taskDateStart}` }]
                    ]);

                    await bot.api.sendMessageToUser(
                        chatId,
                        `🦷 Уважаемый(ая) ${client.full_name || 'клиент'}!\n\n` +
                        `Пожалуйста, оцените ваш визит к врачу ${doctorFullName}\n` +
                        `📅 Дата: ${appointmentDate}\n` +
                        `🕐 Время: ${appointmentTime}\n\n` +
                        `Насколько вы довольны приемом?`,
                        keyboard
                    );

                    sentReviews.set(reviewKey, Date.now());
                    sentCount++;

                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            console.log(`📊 Отправлено запросов отзывов (MAX): ${sentCount}`);

        } catch (error) {
            console.error('❌ Ошибка в checkCompletedAppointments (MAX):', error);
        }
    };

    // const reviewInterval = setInterval(checkCompletedAppointments, REVIEW_CHECK_INTERVAL);
    // setTimeout(checkCompletedAppointments, 15000);

    // === Напоминания раз в сутки в 9:00 ===
    let reminderTimeout;
    const scheduleDailyCheck = () => {
        if (reminderTimeout) clearInterval(reminderTimeout);

        const now = dayjs();
        const next9am = dayjs().hour(9).minute(0).second(0);
        let delay = next9am.diff(now);
        if (delay <= 0) delay = dayjs().add(1, 'day').hour(9).minute(0).second(0).diff(now);

        reminderTimeout = setTimeout(() => {
            checkAndSendReminders(bot).catch(console.error);
            setInterval(() => checkAndSendReminders(bot).catch(console.error), 24 * 60 * 60 * 1000);
        }, delay);

        console.log(`⏰ Проверка напоминаний (MAX): раз в сутки в 09:00 (следующая через ${Math.floor(delay / 1000 / 60)} мин)`);
    };
    scheduleDailyCheck();


    //  let reminderTimeout;
    // const scheduleDailyCheck = () => {
    //     if (reminderTimeout) clearInterval(reminderTimeout);
    //     reminderTimeout = setInterval(() => {
    //         checkAndSendReminders(bot).catch(console.error);
    //     }, 60 * 1000); // каждую минуту
    //     console.log('⏰ Проверка напоминаний: каждую минуту (временно)');
    // };
    // scheduleDailyCheck();

    // === Непрочитанные сообщения ===
    const checkUnreadMessages = async () => {
        try {
            const clients = await pool.query(
                `SELECT max_id, clinic_person_id FROM client WHERE max_id IS NOT NULL`
            );

            for (const client of clients.rows) {
                if (!client.max_id) continue;
                const chatId = client.clinic_person_id || client.max_id;

                try {
                    const response = await fetch(`${ADMIN_API_URL}/chat/public/unread/${chatId}`);
                    const data = await response.json();

                    const prevRes = await medCorePool.query(
                        `SELECT last_unread_message_id, last_unread_chat_message_id, last_unread_count
                         FROM chats WHERE client_id = $1`,
                        [chatId]
                    );

                    const prev = prevRes.rows[0] || {};
                    const prevMsgId = prev.last_unread_message_id || null;
                    const prevChatMsgId = prev.last_unread_chat_message_id ? String(prev.last_unread_chat_message_id) : null;
                    const apiChatMsgId = data.last_message_id ? String(data.last_message_id) : null;
                    const unreadCount = Number(data.unread_count) || 0;

                    if (unreadCount > 0 && apiChatMsgId !== prevChatMsgId) {
                        if (prevMsgId) {
                            try { await bot.api.deleteMessage(client.max_id, prevMsgId); } catch (e) {}
                        }

                        const result = await bot.api.sendMessageToUser(
                            client.max_id,
                            `📬 У вас ${unreadCount} новых сообщений\n\n📱 Войдите в чат в приложении`
                        );

                        if (result?.body?.mid) {
                            await medCorePool.query(
                                `UPDATE chats SET last_unread_message_id = $1, last_unread_chat_message_id = $2, last_unread_count = $3 WHERE client_id = $4`,
                                [result.body.mid, apiChatMsgId, unreadCount, chatId]
                            );
                        }
                    } else if (unreadCount === 0 && prevMsgId) {
                        try { await bot.api.deleteMessage(client.max_id, prevMsgId); } catch (e) {}
                        await medCorePool.query(
                            `UPDATE chats SET last_unread_message_id = NULL, last_unread_chat_message_id = NULL, last_unread_count = 0 WHERE client_id = $1`,
                            [chatId]
                        );
                    }
                } catch (err) {
                    console.error('Ошибка клиента (MAX):', err.message);
                }
            }
        } catch (err) {
            console.error('Ошибка (MAX):', err);
        }
    };
    const unreadInterval = setInterval(checkUnreadMessages, 10 * 1000);

    const mailingInterval = setInterval(() => {
        processPendingMailings(bot).catch(console.error);
    }, 10 * 60 * 1000);
    setTimeout(() => processPendingMailings(bot).catch(console.error), 10000);

    // === Постоянные напоминания ===
    const permanentReminderInterval = setInterval(() => {
        processPermanentReminders(bot).catch(console.error);
    }, 10 * 60 * 1000);
    setTimeout(() => processPermanentReminders(bot).catch(console.error), 15000);

    return { 
        bonusInterval, 
        paymentInterval, 
        reminderTimeout, 
        unreadInterval, 
        mailingInterval, 
        permanentReminderInterval,
        // reviewInterval
    };
}

module.exports = { startIntervals };