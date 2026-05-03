// bot.js (MAX версия - обновлённый)
const { Bot } = require('@maxhub/max-bot-api');
const config = require('./config');
const {
    handleStart, handleAgreeProcessing, handleContact,
    handleConfirmData, handleCancelAuth
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
    console.log('✅ Обработчики зарегистрированы');
}

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