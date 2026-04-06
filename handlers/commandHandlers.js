// handlers/commandHandlers.js
const { checkAndSendReminders } = require('./reminderHandlers');
const { checkClientExists } = require('../services/clientService');

function handleHelp(bot) {
    bot.command('help', async (ctx) => {
        await ctx.reply(
            `📋 *Справка по командам:*\n\n` +
            `/start - начать работу\n` +
            `/check - проверить записи и отправить напоминания\n` +
            `/help - показать это сообщение`,
            { format: 'markdown' }
        );
    });
}

function handleCheck(bot) {
    bot.command('check', async (ctx) => {
        const userId = ctx.message?.sender?.user_id;
        
        const isAuthorized = await checkClientExists(userId);
        
        if (!isAuthorized) {
            await ctx.reply(`❌ *Доступ запрещен*\n\nНажмите /start для авторизации.`, { format: 'markdown' });
            return;
        }
        
        await ctx.reply('🔍 Начинаю проверку записей...');
        
        try {
            await checkAndSendReminders();
            await ctx.reply('✅ Проверка завершена! Напоминания отправлены.');
        } catch (error) {
            console.error('Ошибка при проверке:', error);
            await ctx.reply('❌ Произошла ошибка при проверке');
        }
    });
}

module.exports = { handleHelp, handleCheck };