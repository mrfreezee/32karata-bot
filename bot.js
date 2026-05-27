// bot.js (MAX версия - обновлённый)
const { Bot } = require('@maxhub/max-bot-api');
const config = require('./config');
const {
    handleStart, handleAgreeProcessing, handleContact,
    handleConfirmData, handleCancelAuth,
    handleSelectClient
} = require('./handlers/authHandlers');
const { handleHelp, handleCheck } = require('./handlers/commandHandlers');
const { handleReminderConfirm } = require('./handlers/reminderHandlers');
const { startIntervals } = require('./intervals');
const https = require('https');

let bot = null;
let intervals = {};

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
    handleStart(botInstance);
    handleAgreeProcessing(botInstance);
    handleContact(botInstance);
    handleConfirmData(botInstance);
    handleCancelAuth(botInstance);
    handleHelp(botInstance);
    handleCheck(botInstance);
    handleReminderConfirm(botInstance);
    handleSelectClient(botInstance)
    console.log('✅ Обработчики зарегистрированы');
}

process.on('uncaughtException', (err) => {
    console.error('❌ Необработанная ошибка:', err.message);
    if (err.message?.includes('Connect Timeout') || err.message?.includes('fetch failed')) {
        console.log('🔄 Перезапуск из-за сетевой ошибки...');
        process.exit(1);
    }
});

process.on('unhandledRejection', (reason) => {
    console.error('❌ Необработанный reject:', reason?.message || reason);
    if (reason?.message?.includes('Connect Timeout') || reason?.message?.includes('fetch failed')) {
        console.log('🔄 Перезапуск из-за сетевой ошибки...');
        process.exit(1);
    }
});

function init() {
    console.log('🚀 Инициализация MAX бота...');
    bot = createBot();
    setupHandlers(bot);
    bot.start();
    console.log('🤖 MAX Бот успешно запущен!');
    intervals = startIntervals(bot);
}

process.once('SIGINT', () => {
    if (intervals.bonusInterval) clearInterval(intervals.bonusInterval);
    if (intervals.paymentInterval) clearInterval(intervals.paymentInterval);
    if (intervals.unreadInterval) clearInterval(intervals.unreadInterval);
    if (intervals.reminderTimeout) clearTimeout(intervals.reminderTimeout);
    if (bot) bot.stop();
    process.exit(0);
});

init();