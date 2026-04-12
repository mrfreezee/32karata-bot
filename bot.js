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

// Флаг для предотвращения повторной инициализации
let isInitialized = false;

// Создаем агент с правильными настройками для избежания ECONNRESET
const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    timeout: 60000,
    rejectUnauthorized: false
});

const bot = new Bot(config.BOT_TOKEN, {
    api: {
        agent: agent,
        timeout: 60000,
        apiTimeout: 60000,
        apiTimeoutWebhook: 60000
    }
});

// Регистрация обработчиков только один раз
if (!isInitialized) {
    handleStart(bot);
    handleAgreeProcessing(bot);
    handleContact(bot);
    handleConfirmData(bot);
    handleCancelAuth(bot);
    handleHelp(bot);
    handleCheck(bot);
    handleReminderConfirm(bot);
    isInitialized = true;
    console.log('✅ Обработчики зарегистрированы');
}

// Глобальная переменная для отслеживания активного интервала
let reminderInterval = null;

// Автоматическая проверка каждый день в 9:00
const dayjs = require('dayjs');
const logger = require('./services/loggerService');
const scheduleDailyCheck = () => {
    // Очищаем существующий интервал, если он есть
    if (reminderInterval) {
        clearInterval(reminderInterval);
        reminderInterval = null;
        console.log('🔄 Очищен старый интервал напоминаний');
    }

    const now = dayjs();
    const next9am = dayjs().hour(9).minute(0).second(0);
    let delay = next9am.diff(now);
    
    if (delay <= 0) {
        delay = dayjs().add(1, 'day').hour(9).minute(0).second(0).diff(now);
    }

    setTimeout(() => {
        console.log('⏰ Запуск ежедневной проверки...');
        checkAndSendReminders(bot).catch(console.error);
        reminderInterval = setInterval(() => {
            console.log('⏰ Запуск ежедневной проверки...');
            checkAndSendReminders(bot).catch(console.error);
        }, 24 * 60 * 60 * 1000);
    }, delay);
};

scheduleDailyCheck();

// Функция запуска бота с повторными попытками
const startBotWithRetry = async (retries = 5, delay = 5000) => {
    for (let i = 0; i < retries; i++) {
        try {
            await bot.start();
            logger.info('Бот успешно запущен', { retries: i + 1 });
            console.log('🤖 Бот успешно запущен!');
            return;
        } catch (err) {
            logger.error(err, { function: 'startBotWithRetry', attempt: i + 1 });
            console.error(`❌ Ошибка запуска (попытка ${i + 1}/${retries}):`, err.message);
            if (i < retries - 1) {
                console.log(`⏳ Повтор через ${delay / 1000} секунд...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                console.error('❌ Не удалось запустить бота после всех попыток');
                process.exit(1);
            }
        }
    }
};

// Глобальная обработка ошибок сети
process.on('uncaughtException', (err) => {
     logger.error(err, { type: 'uncaughtException' });
    if (err.code === 'ECONNRESET' || err.message?.includes('ECONNRESET') || err.message?.includes('fetch failed')) {
        console.log('🔄 Переподключение из-за сетевой ошибки...');
        setTimeout(() => {
            startBotWithRetry(3, 3000);
        }, 3000);
    } else {
        console.error('Uncaught Exception:', err);
    }
});

process.on('unhandledRejection', (reason) => {
    logger.error(reason, { type: 'unhandledRejection' });
    if (reason?.code === 'ECONNRESET' || reason?.message?.includes('ECONNRESET') || reason?.message?.includes('fetch failed')) {
        console.log('🔄 Переподключение из-за сетевой ошибки (rejection)...');
        setTimeout(() => {
            startBotWithRetry(3, 3000);
        }, 3000);
    } else {
        console.error('Unhandled Rejection:', reason);
    }
});

// Обработка graceful shutdown
process.on('SIGINT', () => {
    console.log('🛑 Остановка бота...');
    if (reminderInterval) {
        clearInterval(reminderInterval);
    }
    bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Остановка бота...');
    if (reminderInterval) {
        clearInterval(reminderInterval);
    }
    bot.stop();
    process.exit(0);
});

// Запуск бота
startBotWithRetry();