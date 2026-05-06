const { pool } = require('../db');
const dayjs = require('dayjs');
const logger = require('./loggerService');


async function createReminder(messengerId, platform = 'max', scheduleId, kind, messageId, chatId) {
    try {
        const idColumn = platform === 'telegram' ? 'tg_id' 
                       : platform === 'max' ? 'max_id' 
                       : 'vk_id';
        
        const query = `
            INSERT INTO reminders (${idColumn}, platform, schedid, kind, sent_at, is_active, message_id, chat_id)
            VALUES ($1, $2, $3, $4, NOW(), true, $5, $6)
            RETURNING id
        `;
        const result = await pool.query(query, [messengerId, platform, scheduleId, kind, messageId, chatId]);
        
        logger.reminderSent(messengerId, platform, scheduleId, kind, messageId, chatId);
        
        return result.rows[0].id;
    } catch (error) {
        logger.error(error, { function: 'createReminder', messengerId, platform, scheduleId, kind });
        throw error;
    }
}


async function updateReminderAck(reminderId, messengerId, platform) {
    try {
        const query = `
            UPDATE reminders 
            SET ack_at = NOW(), ack_by = $1, is_active = false
            WHERE id = $2
        `;
        await pool.query(query, [messengerId, reminderId]);
        
        logger.reminderAck(reminderId, messengerId, platform);
    } catch (error) {
        logger.error(error, { function: 'updateReminderAck', reminderId, messengerId, platform });
        throw error;
    }
}


async function checkExistingReminder(scheduleId) {
    const result = await pool.query(
        `SELECT id, kind, is_active, platform FROM reminders 
         WHERE schedid = $1`,
        [scheduleId]
    );
    return result.rows.length > 0;
}


async function findReminderByScheduleId(scheduleId) {
    const result = await pool.query(
        `SELECT id, tg_id, max_id, vk_id, platform, schedid, kind, message_id, chat_id 
         FROM reminders 
         WHERE schedid = $1 AND is_active = true`,
        [scheduleId]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
}

module.exports = { 
    createReminder, 
    updateReminderAck, 
    checkExistingReminder,
    findReminderByScheduleId 
};