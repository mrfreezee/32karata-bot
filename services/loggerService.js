// services/loggerService.js
const fs = require('fs');
const path = require('path');

// Создаем папку для логов, если её нет
const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// Функция для записи в файл
function writeLog(filename, data) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] ${JSON.stringify(data)}\n`;
    
    fs.appendFile(path.join(logDir, filename), logEntry, (err) => {
        if (err) console.error('Ошибка записи лога:', err);
    });
}

// Основной логгер
const logger = {
    // Кто запустил бота
    botStart: (userId, userName, startParam = null) => {
        const data = {
            type: 'BOT_START',
            userId,
            userName,
            startParam,
            message: `Пользователь ${userName} (${userId}) запустил бота${startParam ? ` с параметром ${startParam}` : ''}`
        };
        console.log(`🤖 ${data.message}`);
        writeLog('bot_starts.log', data);
    },

    // Отправка напоминания
    reminderSent: (userId, scheduleId, kind, messageId, chatId) => {
        const data = {
            type: 'REMINDER_SENT',
            userId,
            scheduleId,
            kind,
            messageId,
            chatId,
            message: `Напоминание (${kind}) отправлено пользователю ${userId}`
        };
        console.log(`📨 ${data.message}`);
        writeLog('reminders.log', data);
    },

    // Подтверждение напоминания
    reminderAck: (reminderId, userId, kind) => {
        const data = {
            type: 'REMINDER_ACK',
            reminderId,
            userId,
            kind,
            message: `Напоминание ${reminderId} подтверждено пользователем ${userId}`
        };
        console.log(`✅ ${data.message}`);
        writeLog('reminders.log', data);
    },

    // Ошибки
    error: (error, context = {}) => {
        const data = {
            type: 'ERROR',
            timestamp: new Date().toISOString(),
            error: {
                message: error.message,
                stack: error.stack,
                code: error.code
            },
            context,
            message: `Ошибка: ${error.message}`
        };
        console.error(`❌ ${data.message}`);
        writeLog('errors.log', data);
    },

    // Успешная авторизация
    authSuccess: (userId, phone, clientData) => {
        const data = {
            type: 'AUTH_SUCCESS',
            userId,
            phone,
            clientName: clientData?.display_name,
            message: `Пользователь ${userId} успешно авторизован с номером ${phone}`
        };
        console.log(`✅ ${data.message}`);
        writeLog('auth.log', data);
    },

    // Отмена авторизации
    authCancel: (userId) => {
        const data = {
            type: 'AUTH_CANCEL',
            userId,
            message: `Пользователь ${userId} отменил авторизацию`
        };
        console.log(`❌ ${data.message}`);
        writeLog('auth.log', data);
    },

    // Согласие на обработку данных
    consentGiven: (userId) => {
        const data = {
            type: 'CONSENT_GIVEN',
            userId,
            message: `Пользователь ${userId} дал согласие на обработку данных`
        };
        console.log(`📄 ${data.message}`);
        writeLog('auth.log', data);
    },

    // Инфо сообщения
    info: (message, data = {}) => {
        const logData = {
            type: 'INFO',
            message,
            ...data
        };
        console.log(`ℹ️ ${message}`);
        writeLog('info.log', logData);
    }
};

module.exports = logger;