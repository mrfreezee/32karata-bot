const dayjs = require('dayjs');
const { Keyboard } = require('@maxhub/max-bot-api');
const { getUnsentBonuses, markBonusAsNotified, processPendingMailings, processPermanentReminders } = require('./services/clientService');
const { checkAndSendReminders } = require('./handlers/reminderHandlers');
const { medCorePool, pool } = require('./db');
const {
    shouldSkipDoctor,
    saveReview,
    saveReviewText,
    setWaitingForText,
    getWaitingForText,
    clearWaitingForText,
    getPatientReviewsCount
} = require('./services/reviewService');
const { getReviewLinks } = require('./utils/reviewLinks');

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:5005/api';
const API_CLIENT_URL = process.env.API_CLIENT_URL ? process.env.API_CLIENT_URL.replace(/\/$/, '') : '';
const API_TOKEN = process.env.API_TOKEN;
const API_SECRET = process.env.API_SECRET;
const LOCATION = process.env.LOCATION;

const sentReviews = new Map();

function setupReviewHandlers(bot) {
    bot.action(/^review_(\d+)_(\d+)_(\d+)_(.+)$/, async (ctx) => {
        try {
            const userId = ctx.callback?.user?.user_id;
            const chatId = ctx.callback?.message?.chat?.id;

            const match = ctx.match;
            const stars = parseInt(match[1]);
            const patientId = match[2];
            const doctorId = match[3];
            const appointmentDate = match[4];

            console.log(`⭐ Получена оценка ${stars} от MAX пользователя ${userId}`);
            console.log(`   Пациент: ${patientId}, Врач: ${doctorId}, Дата: ${appointmentDate}`);

            // 🔥 ПРОВЕРКА: Есть ли уже отзыв в ЛЮБОЙ платформе (clinic_id = 3)
            const existingReview = await medCorePool.query(
                `SELECT id, review_source, review_text, stars FROM reviews 
                 WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3 AND clinic_id = 3`,
                [patientId, doctorId, appointmentDate]
            );

            if (existingReview.rows.length > 0) {
                const review = existingReview.rows[0];

                // Проверяем, откуда пришел отзыв
                if (review.review_source === 'max') {
                    await ctx.reply(
                        `⚠️ Вы уже оставили отзыв на этот визит в MAX!\n\n` +
                        `Ваша оценка: ${review.stars} из 10\n` +
                        `Текст: ${review.review_text || 'не указан'}\n\n` +
                        `Спасибо за ваше мнение! 🙏`
                    );
                } else if (review.review_source === 'telegram') {
                    await ctx.reply(
                        `✅ Спасибо! Вы уже оставили отзыв на этот визит в Telegram.\n\n` +
                        `Ваша оценка: ${review.stars} из 10\n` +
                        `Текст: ${review.review_text || 'не указан'}\n\n` +
                        `Спасибо за ваше мнение! 🙏`
                    );
                }

                // Удаляем из pending_reviews (clinic_id = 3)
                await medCorePool.query(
                    `DELETE FROM pending_reviews 
                     WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3 AND clinic_id = 3`,
                    [patientId, doctorId, appointmentDate]
                );

                // Отвечаем на callback
                try {
                    await ctx.answerCallbackQuery({
                        text: 'ℹ️ Вы уже оставили отзыв на этот визит'
                    });
                } catch (e) {
                    console.log('ℹ️ Не удалось отправить ответ на callback');
                }

                return;
            }

            // Если отзыва нет - создаем новый
            // Получаем branch_id и doctor_name из pending_reviews (clinic_id = 3)
            const pendingResult = await medCorePool.query(
                `SELECT branch_id, doctor_name FROM pending_reviews 
                 WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3 AND clinic_id = 3`,
                [patientId, doctorId, appointmentDate]
            );

            const branchId = pendingResult.rows[0]?.branch_id || null;
            const doctorName = pendingResult.rows[0]?.doctor_name || '';

            // Создаем новый отзыв с пометкой 'max' и clinic_id = 3
            const insertResult = await medCorePool.query(
                `INSERT INTO reviews (
                    patient_id, doctor_id, doctor_name, stars, appointment_date, 
                    branch_id, max_id, review_source, created_at, waiting_for_text, clinic_id
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'max', NOW(), true, 3)
                RETURNING id`,
                [patientId, doctorId, doctorName, stars, appointmentDate, branchId, userId]
            );

            const reviewId = insertResult.rows[0].id;
            console.log(`✅ Создан новый отзыв: id=${reviewId}`);

            // Удаляем из pending_reviews (clinic_id = 3)
            await medCorePool.query(
                `DELETE FROM pending_reviews 
                 WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3 AND clinic_id = 3`,
                [patientId, doctorId, appointmentDate]
            );

            // 🔥 ПОЛУЧАЕМ ССЫЛКИ ДЛЯ ОТЗЫВОВ
            const links = getReviewLinks(LOCATION, branchId);

            // 🔥 ОПРЕДЕЛЯЕМ, СКОЛЬКО ОТЗЫВОВ У ПАЦИЕНТА (ВСЕГО)
            const patientReviewsCount = await getPatientReviewsCount(patientId);

            console.log(`📊 У пациента ${patientId} всего ${patientReviewsCount} отзывов`);

            // 🔥 ФОРМИРУЕМ СООБЩЕНИЕ В ЗАВИСИМОСТИ ОТ НОМЕРА ОТЗЫВА
            let message = `✅ Спасибо за вашу оценку ${stars} из 10!\n\n`;

            // Если это первый отзыв пациента - Яндекс
            if (patientReviewsCount === 1) {
                message +=
                    `📝 Пожалуйста, оставьте развернутый отзыв о визите к врачу ${doctorName}.\n\n` +
                    `🌟 Оставьте отзыв на Яндекс Картах:\n` +
                    `${links.yandexLink}\n\n` +
                    `Ваше мнение очень важно для нас! 🙏`;
            } else {
                // Второй и последующие отзывы - 2ГИС
                message +=
                    `📝 Пожалуйста, оставьте развернутый отзыв о визите к врачу ${doctorName}.\n\n` +
                    `🌟 Оставьте отзыв в приложении 2ГИС:\n` +
                    `${links.gisLink}\n\n` +
                    `Ваше мнение очень важно для нас! 🙏`;
            }

            // Отправляем сообщение со ссылками
            await ctx.reply(message);

            console.log(`✅ Отправлено сообщение со ссылками для отзыва (отзыв #${patientReviewsCount})`);

            // Отвечаем на callback
            try {
                await ctx.answerCallbackQuery({
                    text: `✅ Оценка ${stars} из 10 сохранена!`
                });
            } catch (e) {
                console.log('ℹ️ Не удалось отправить ответ на callback');
            }

        } catch (error) {
            console.error('❌ Ошибка в обработчике review callback:', error);
            await ctx.reply('❌ Произошла ошибка. Пожалуйста, попробуйте позже.');
        }
    });
}

// ==================== ИНТЕРВАЛЫ ====================

function startIntervals(bot) {

    setupReviewHandlers(bot);

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

    // === Проверка завершенных приемов ===
    const checkCompletedAppointments = async () => {
    console.log('🔍 Проверка завершенных приемов для запроса отзывов (MAX)...');

    try {
        const today = dayjs().format('YYYY-MM-DD');
        const url = `${API_CLIENT_URL}/api/mobile/schedule?token=${API_TOKEN}&secret=${API_SECRET}&date_start=${today}&date_end=${today}`;

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

        let sentCount = 0;

        for (const doctor of data) {
            if (shouldSkipDoctor(doctor.title, doctor.subtitle, doctor.tooltip)) {
                continue;
            }

            const doctorId = doctor.id;
            const doctorFullName = doctor.tooltip || doctor.title;

            let branchId = null;
            const blocks = doctor.blocks || [];
            const infoBlock = blocks.find(block => block.type === 'info');

            if (infoBlock && infoBlock.branchID) {
                branchId = infoBlock.branchID;
            } else {
                branchId = LOCATION === 'mosc' ? 50 : 3;
            }

            const tasks = doctor.tasks || [];

            for (const task of tasks) {
                const patientID = task.patientID;
                const taskDateStart = task.date_start;
                const taskDateEnd = task.date_end;

                if (!patientID) continue;

                const endTime = dayjs(taskDateEnd);
                const now = dayjs();
                const minutesSinceEnd = now.diff(endTime, 'minute');

                if (endTime.isAfter(now)) continue;
                if (minutesSinceEnd < 30) continue;

                const reviewKey = `${patientID}_${doctorId}_${taskDateStart}`;

                const nowTime = Date.now();
                for (const [key, time] of sentReviews.entries()) {
                    if (nowTime - time > 24 * 60 * 60 * 1000) {
                        sentReviews.delete(key);
                    }
                }

                if (sentReviews.has(reviewKey)) continue;

                // Ищем клиента с max_id
                const clientResult = await pool.query(
                    `SELECT id, max_id, tg_id, full_name, phone, clinic_person_id
                     FROM client 
                     WHERE clinic_person_id = $1 AND location = $2 AND max_id IS NOT NULL`,
                    [String(patientID), LOCATION]
                );

                if (!clientResult.rows.length) {
                    continue;
                }

                const client = clientResult.rows[0];
                const maxChatId = client.max_id;

                if (!maxChatId) continue;

                // Проверяем, есть ли уже отзыв
                const existingReview = await medCorePool.query(
                    `SELECT id FROM reviews 
                     WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3 AND clinic_id = 3`,
                    [String(patientID), doctorId, taskDateStart]
                );

                if (existingReview.rows.length) {
                    sentReviews.set(reviewKey, Date.now());
                    continue;
                }

                // Проверяем pending_reviews - отправляли ли уже в MAX
                const existingPending = await medCorePool.query(
                    `SELECT id, max_sent FROM pending_reviews 
                     WHERE patient_id = $1 AND doctor_id = $2 AND appointment_date = $3  AND clinic_id = 3`,
                    [String(patientID), doctorId, taskDateStart]
                );

                let needSend = false;

                if (existingPending.rows.length > 0) {
                    if (!existingPending.rows[0].max_sent) {
                        needSend = true;
                        await medCorePool.query(
                            `UPDATE pending_reviews 
                             SET max_sent = true, 
                                 max_sent_at = NOW(), 
                                 max_chat_id = $1
                             WHERE id = $2`,
                            [maxChatId, existingPending.rows[0].id]
                        );
                    }
                } else {
                    await medCorePool.query(
                        `INSERT INTO pending_reviews (
                            patient_id, doctor_id, doctor_name, appointment_date, 
                            branch_id, tg_chat_id, max_chat_id, 
                            tg_sent, max_sent, tg_sent_at, max_sent_at, created_at, clinic_id
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), 3)`,
                        [
                            String(patientID), doctorId, doctorFullName, taskDateStart,
                            branchId,
                            null,
                            maxChatId,
                            false,
                            true,
                            null,
                            new Date()
                        ]
                    );
                    needSend = true;
                }

                if (!needSend) {
                    sentReviews.set(reviewKey, Date.now());
                    continue;
                }

                const appointmentDate = dayjs(taskDateStart).format('DD.MM.YYYY');
                const appointmentTime = dayjs(taskDateStart).format('HH:mm');

                // Клавиатура для MAX
                const keyboard = {
                    attachments: [
                        {
                            type: "inline_keyboard",
                            payload: {
                                buttons: [
                                    [
                                        { type: "callback", text: "1️⃣", payload: `review_1_${patientID}_${doctorId}_${taskDateStart}` },
                                        { type: "callback", text: "2️⃣", payload: `review_2_${patientID}_${doctorId}_${taskDateStart}` },
                                        { type: "callback", text: "3️⃣", payload: `review_3_${patientID}_${doctorId}_${taskDateStart}` },
                                        { type: "callback", text: "4️⃣", payload: `review_4_${patientID}_${doctorId}_${taskDateStart}` },
                                        { type: "callback", text: "5️⃣", payload: `review_5_${patientID}_${doctorId}_${taskDateStart}` }
                                    ],
                                    [
                                        { type: "callback", text: "6️⃣", payload: `review_6_${patientID}_${doctorId}_${taskDateStart}` },
                                        { type: "callback", text: "7️⃣", payload: `review_7_${patientID}_${doctorId}_${taskDateStart}` },
                                        { type: "callback", text: "8️⃣", payload: `review_8_${patientID}_${doctorId}_${taskDateStart}` },
                                        { type: "callback", text: "9️⃣", payload: `review_9_${patientID}_${doctorId}_${taskDateStart}` },
                                        { type: "callback", text: "🔟", payload: `review_10_${patientID}_${doctorId}_${taskDateStart}` }
                                    ]
                                ]
                            }
                        }
                    ]
                };

                await bot.api.sendMessageToUser(
                    maxChatId,
                    `🦷 Уважаемый(ая) ${client.full_name || 'клиент'}!\n\n` +
                    `Пожалуйста, оцените ваш визит к врачу ${doctorFullName}\n` +
                    `📅 Дата: ${appointmentDate}\n` +
                    `🕐 Время: ${appointmentTime}\n\n` +
                    `Оцените прием по шкале от 1 до 10:\n` +
                    `1️⃣ - ужасно, 1️⃣0️⃣ - превосходно`,
                    keyboard
                );

                sentReviews.set(reviewKey, Date.now());
                sentCount++;
                console.log(`📨 Отправлено в MAX для ${appointmentDate} ${appointmentTime}`);

                await new Promise(r => setTimeout(r, 1000));
            }
        }

        console.log(`📊 Отправлено запросов в MAX: ${sentCount}`);

    } catch (error) {
        console.error('❌ Ошибка в checkCompletedAppointments (MAX):', error);
  
    }
};


const checkBirthdays = async () => {
    console.log(`🎂 Проверка дней рождения [${new Date().toLocaleString('ru-RU')}]`);

    try {
        // Получаем клиентов у которых сегодня день рождения
        const birthdayClients = await pool.query(`
            SELECT 
                id,
                tg_id,
                max_id,
                vk_id,
                full_name,
                phone,
                clinic_person_id,
                bonus_balance,
                birth_date,
                location
            FROM client 
            WHERE location = $1
              AND birth_date IS NOT NULL
              AND EXTRACT(MONTH FROM birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)
              AND EXTRACT(DAY FROM birth_date) = EXTRACT(DAY FROM CURRENT_DATE)
        `, [LOCATION]);

        if (birthdayClients.rows.length === 0) {
            console.log('   ℹ️ Нет клиентов с днём рождения сегодня');
            return;
        }

        console.log(`   🎉 Найдено ${birthdayClients.rows.length} клиентов с днём рождения`);

        let processed = 0;
        let errors = 0;

        for (const client of birthdayClients.rows) {
            try {
                // Проверяем, не начисляли ли уже бонус сегодня
                const existingBonus = await medCorePool.query(`
                    SELECT id, created_at FROM bonus_write_offs 
                    WHERE clinic_patient_id = $1 
                      AND clinic_id = 3 
                      AND bonus_type = 'birthday'
                      AND transaction_type = 'accrual'
                      AND DATE(created_at) = CURRENT_DATE
                    LIMIT 1
                `, [client.clinic_person_id]);

                if (existingBonus.rows.length > 0) {
                    console.log(`   ⏭️ Клиенту ${client.clinic_person_id} уже начислен birthday бонус сегодня (${existingBonus.rows[0].created_at})`);
                    continue;
                }

                const chatId = client.max_id 
                
                if (!chatId) {
                    console.log(`   ⚠️ У клиента ${client.id} нет ID для отправки сообщения`);
                    // Пропускаем, но не начисляем бонус
                    continue;
                }

                const birthdayBonus = 1600;
                const oldBalance = client.bonus_balance || 0;
                const newBalance = oldBalance + birthdayBonus;

                // 1. Обновляем баланс клиента в 32karata
                await pool.query(
                    `UPDATE client SET bonus_balance = $1 WHERE id = $2`,
                    [newBalance, client.id]
                );

                // 2. Получаем patient_id из medCore
                const patientResult = await medCorePool.query(
                    `SELECT id FROM patients WHERE clinic_patient_id = $1 AND clinic_id = 3 LIMIT 1`,
                    [client.clinic_person_id]
                );

                let patientId = null;
                if (patientResult.rows.length > 0) {
                    patientId = patientResult.rows[0].id;
                }

                // 3. Сохраняем историю начисления в medCore
                if (patientId) {
                    await medCorePool.query(`
                        INSERT INTO bonus_write_offs (
                            patient_id,
                            clinic_id,
                            clinic_patient_id,
                            amount,
                            reason,
                            old_balance,
                            new_balance,
                            transaction_type,
                            bonus_type,
                            created_at
                        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'accrual', 'birthday', NOW())
                    `, [
                        patientId,
                        3,
                        client.clinic_person_id,
                        birthdayBonus,
                        `🎂 Бонус за день рождения`,
                        oldBalance,
                        newBalance
                    ]);
                }

                // 4. Отправляем поздравление
                const message = 
                    `🎂 С Днём Рождения! 🎉\n\n` +
                    `Мы хотим поздравить Вас с этим замечательным днём и сделать подарок! 🎁\n\n` +
                    `💰 Вам начислено ${birthdayBonus} бонусов!\n\n` +
                    `⏰ Успейте воспользоваться ими в течение 30 дней!\n` +
                    `Бонусы будут доступны для оплаты услуг в нашей клинике.\n\n` +
                    `Спасибо, что Вы с нами! ❤️`;

                await bot.api.sendMessageToUser(chatId, message, {
                    parse_mode: 'Markdown'
                });

                processed++;
                console.log(`   ✅ ${client.full_name} (${client.clinic_person_id}): начислено ${birthdayBonus} бонусов, баланс: ${oldBalance} → ${newBalance}`);

                // Небольшая задержка между отправками
                await new Promise(r => setTimeout(r, 1000));

            } catch (err) {
                errors++;
                console.error(`   ❌ Ошибка при обработке клиента ${client.id}:`, err.message);
                
                // Если ошибка в отправке, но бонус уже начислен, логируем
                if (err.message.includes('chat not found') || err.message.includes('blocked')) {
                    console.log(`   📌 Клиент ${client.id} заблокировал бота, бонус не начислен`);
                }
            }
        }

        console.log(`\n✅ Проверка дней рождения завершена:`);
        console.log(`   🎉 Обработано: ${processed}`);
        console.log(`   ❌ Ошибок: ${errors}`);

    } catch (error) {
        console.error('❌ Ошибка при проверке дней рождения:', error);
    }
};

const BIRTHDAY_CHECK_INTERVAL = 60 * 60 * 1000;

// Запускаем проверку дней рождения
const birthdayInterval = setInterval(checkBirthdays, BIRTHDAY_CHECK_INTERVAL);
setTimeout(checkBirthdays, 30000); 


    const REVIEW_CHECK_INTERVAL = 30 * 60 * 1000;
    const reviewInterval = setInterval(checkCompletedAppointments, REVIEW_CHECK_INTERVAL);
    setTimeout(checkCompletedAppointments, 15000);

    // === Напоминания ===
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

//     const scheduleDailyCheck = () => {
//     if (reminderTimeout) clearInterval(reminderTimeout);
//     reminderTimeout = setInterval(() => {
//         checkAndSendReminders(bot).catch(console.error);
//     }, 60000);
//     console.log(`⏰ Проверка напоминаний: каждую минуту`);
// };

    scheduleDailyCheck();

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
                            try { await bot.api.deleteMessage(client.max_id, prevMsgId); } catch (e) { }
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
                        try { await bot.api.deleteMessage(client.max_id, prevMsgId); } catch (e) { }
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
        reviewInterval,
        birthdayInterval
    };
}

module.exports = { startIntervals };