// services/reminderService.js
const { pool } = require('../db');
const dayjs = require('dayjs');
const logger = require('./loggerService');

async function createReminder(userId, scheduleId, kind, messageId, chatId) {
    try {
        const query = `
            INSERT INTO reminders (user_id, schedid, kind, sent_at, is_active, message_id, chat_id)
            VALUES ($1, $2, $3, NOW(), true, $4, $5)
            RETURNING id
        `;
        const result = await pool.query(query, [userId, scheduleId, kind, messageId, chatId]);
        
        logger.reminderSent(userId, scheduleId, kind, messageId, chatId);
        
        return result.rows[0].id;
    } catch (error) {
        logger.error(error, { function: 'createReminder', userId, scheduleId, kind });
        throw error;
    }
}

async function updateReminderAck(reminderId, userId) {
    try {
        const query = `
            UPDATE reminders 
            SET ack_at = NOW(), ack_by = $1, is_active = false
            WHERE id = $2
        `;
        await pool.query(query, [userId, reminderId]);
        
        logger.reminderAck(reminderId, userId);
    } catch (error) {
        logger.error(error, { function: 'updateReminderAck', reminderId, userId });
        throw error;
    }
}

async function checkExistingReminder(scheduleId) {
    const result = await pool.query(
        `SELECT id, kind, is_active FROM reminders 
         WHERE schedid = $1 AND is_active = true`,
        [scheduleId]
    );
    return result.rows.length > 0;
}

module.exports = { createReminder, updateReminderAck, checkExistingReminder };