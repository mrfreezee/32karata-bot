// bot.js
const { Bot } = require('@maxhub/max-bot-api');
const config = require('./config');
const { 
    handleStart, 
    handleAgreeProcessing, 
    handleContact, 
    handleConfirmData, 
    handleCancelAuth 
} = require('./handlers/authHandlers');
const { handleHelp, handleCheck } = require('./handlers/commandHandlers');
const { handleReminderConfirm } = require('./handlers/reminderHandlers');
const { checkAndSendReminders } = require('./handlers/reminderHandlers');
const https = require('https');

let isInitialized = false;
let bot = null;
let reconnectAttempts = 0;
let isReconnecting = false;
let reminderInterval = null;

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY = 5000;

// Создаем агент с правильными настройками
const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    timeout: 120000,
    rejectUnauthorized: false
});

function createBot() {
    return new Bot(config.BOT_TOKEN, {
        api: {
            agent: agent,
            timeout: 120000,
            apiTimeout: 120000,
            apiTimeoutWebhook: 120000
        }
    });
}

function setupHandlers(botInstance) {
    if (!isInitialized) {
        handleStart(botInstance);
        handleAgreeProcessing(botInstance);
        handleContact(botInstance);
        handleConfirmData(botInstance);
        handleCancelAuth(botInstance);
        handleHelp(botInstance);
        handleCheck(botInstance);
        handleReminderConfirm(botInstance);
        isInitialized = true;
        console.log('✅ Обработчики зарегистрированы');
    }
}

async function startBotWithReconnect() {
    if (isReconnecting) {
        console.log('⏳ Already reconnecting, skipping...');
        return;
    }
    
    isReconnecting = true;
    
    try {
        if (bot) {
            try {
                await bot.stop();
            } catch(e) {}
        }
        
        bot = createBot();
        setupHandlers(bot);
        
        await bot.start();
        console.log('🤖 Бот успешно запущен!');
        reconnectAttempts = 0;
        isReconnecting = false;
        
    } catch (err) {
        console.error(`❌ Ошибка запуска (попытка ${reconnectAttempts + 1}):`, err.message);
        reconnectAttempts++;
        isReconnecting = false;
        
        if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
            const delay = BASE_DELAY * Math.min(Math.pow(2, reconnectAttempts - 1), 300);
            console.log(`⏳ Повтор через ${delay / 1000} секунд...`);
            setTimeout(() => startBotWithReconnect(), delay);
        } else {
            console.error('❌ Превышено количество попыток переподключения');
            reconnectAttempts = 0;
            setTimeout(() => startBotWithReconnect(), 60000);
        }
    }
}

// Автоматическая проверка каждый день в 9:00
const dayjs = require('dayjs');
const logger = require('./services/loggerService');

const scheduleDailyCheck = () => {
    if (reminderInterval) {
        clearInterval(reminderInterval);
        reminderInterval = null;
    }

    const now = dayjs();
    const next9am = dayjs().hour(9).minute(0).second(0);
    let delay = next9am.diff(now);
    
    if (delay <= 0) {
        delay = dayjs().add(1, 'day').hour(9).minute(0).second(0).diff(now);
    }

    setTimeout(() => {
        if (bot) {
            checkAndSendReminders(bot).catch(console.error);
        }
        reminderInterval = setInterval(() => {
            if (bot) {
                checkAndSendReminders(bot).catch(console.error);
            }
        }, 24 * 60 * 60 * 1000);
    }, delay);
};

scheduleDailyCheck();

// Периодическая проверка здоровья бота (каждые 5 минут)
setInterval(async () => {
    if (bot && bot.botInfo) {
        try {
            await bot.telegram.getMe();
            console.log('✅ Bot health check OK');
        } catch (err) {
            console.error('❌ Bot health check failed:', err.message);
            startBotWithReconnect();
        }
    } else {
        startBotWithReconnect();
    }
}, 5 * 60 * 1000);

// Обработка ошибок
process.on('uncaughtException', (err) => {
    logger.error(err, { type: 'uncaughtException' });
    console.error('Uncaught Exception:', err.message);
    startBotWithReconnect();
});

process.on('unhandledRejection', (reason) => {
    logger.error(reason, { type: 'unhandledRejection' });
    console.error('Unhandled Rejection:', reason);
    startBotWithReconnect();
});

process.on('SIGINT', () => {
    console.log('🛑 Остановка бота...');
    if (reminderInterval) clearInterval(reminderInterval);
    if (bot) bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Остановка бота...');
    if (reminderInterval) clearInterval(reminderInterval);
    if (bot) bot.stop();
    process.exit(0);
});

// Запуск
startBotWithReconnect();