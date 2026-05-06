// intervals.js (MAX версия)
const dayjs = require('dayjs');
const { Keyboard } = require('@maxhub/max-bot-api');
const { getUnsentBonuses, markBonusAsNotified, processPendingMailings, processPermanentReminders } = require('./services/clientService');
const { checkAndSendReminders } = require('./handlers/reminderHandlers');
const { medCorePool, pool } = require('./db');

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'http://localhost:5005/api';

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
            [process.env.LOCATION]
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

        console.log(`⏰ Проверка напоминаний: раз в сутки в 09:00 (следующая через ${Math.floor(delay / 1000 / 60)} мин)`);
    };
    scheduleDailyCheck();

    // let reminderTimeout;
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
    // console.log('🔍 Проверка непрочитанных...');

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
                    // Удаляем старое уведомление
                    if (prevMsgId) {
                        try { await bot.api.deleteMessage(client.max_id, prevMsgId); } catch (e) {}
                    }

                    // Отправляем новое
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
                console.error('Ошибка клиента:', err.message);
            }
        }

    } catch (err) {
        console.error('Ошибка:', err);
    }
};
    const unreadInterval = setInterval(checkUnreadMessages, 10 * 1000);


    const mailingInterval = setInterval(() => {
        processPendingMailings(bot).catch(console.error);
    }, 10 * 60 * 1000);
    setTimeout(() => processPendingMailings(bot).catch(console.error), 10000);

    // === Постоянные напоминания каждые 5 минут ===
    const permanentReminderInterval = setInterval(() => {
        processPermanentReminders(bot).catch(console.error);
    }, 10 * 60 * 1000);
    setTimeout(() => processPermanentReminders(bot).catch(console.error), 15000);

    return { bonusInterval, paymentInterval, reminderTimeout, unreadInterval, mailingInterval, permanentReminderInterval };
}

module.exports = { startIntervals };