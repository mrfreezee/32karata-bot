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

const bot = new Bot(config.BOT_TOKEN);

// Регистрация обработчиков
handleStart(bot);
handleAgreeProcessing(bot);
handleContact(bot);
handleConfirmData(bot);
handleCancelAuth(bot);
handleHelp(bot);
handleCheck(bot);
handleReminderConfirm(bot);

// Автоматическая проверка каждый день в 9:00
const dayjs = require('dayjs');
const scheduleDailyCheck = () => {
    const now = dayjs();
    const next9am = dayjs().hour(9).minute(0).second(0);
    const delay = next9am.diff(now);

    setTimeout(() => {
        console.log('⏰ Запуск ежедневной проверки...');
        checkAndSendReminders(bot);
        setInterval(() => {
            console.log('⏰ Запуск ежедневной проверки...');
            checkAndSendReminders(bot);
        }, 24 * 60 * 60 * 1000);
    }, delay > 0 ? delay : dayjs().add(1, 'day').hour(9).minute(0).second(0).diff(now));
};

scheduleDailyCheck();

bot.start();
console.log('🤖 Бот запущен!');