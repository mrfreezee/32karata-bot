// handlers/reminderHandlers.js
const { Markup } = require('telegraf');
const dayjs = require('dayjs');
const { getSchedule, findPatientByName } = require('../services/scheduleService');
const { createReminder, updateReminderAck, checkExistingReminder } = require('../services/reminderService');

async function sendReminder(bot, chatId, patient, doctorName, appointmentDate, kind, scheduleId) {
    const date = dayjs(appointmentDate).format('DD.MM.YYYY');
    const hours = dayjs(appointmentDate).hour();
    const minutes = dayjs(appointmentDate).minute();

    let message = kind === '1d' 
        ? `⏰ *Напоминание!*\nЗавтра у вас приём у врача\n🗓 Дата: ${date}\n👨🏻‍⚕️ Врач: ${doctorName}\n🕒 Время: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
        : `📅 *Предварительное напоминание*\nЧерез 3 дня у вас приём у врача\n🗓 Дата: ${date}\n👨🏻‍⚕️ Врач: ${doctorName}\n🕒 Время: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('✅ Подтверждаю', `confirm_reminder_${scheduleId}`)]
    ]);

    try {
        const sentMessage = await bot.telegram.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            ...keyboard
        });

        await createReminder(patient.user_id, scheduleId, kind, sentMessage.message_id, chatId);
        console.log(`📨 Отправлено напоминание (${kind}) пациенту ${patient.full_name}`);
    } catch (error) {
        console.error(`Ошибка отправки:`, error.message);
    }
}

async function checkAndSendReminders(bot) {
    const today = dayjs().format('YYYY-MM-DD');
    const dateEnd = dayjs().add(3, 'days').format('YYYY-MM-DD');

    console.log(`\n=== Проверка напоминаний ${today} - ${dateEnd} ===\n`);

    const schedule = await getSchedule(today, dateEnd);
    if (!schedule.length) return;

    for (const doctor of schedule) {
        for (const task of doctor.tasks || []) {
            if (task.title === 'Резерв' || task.title.includes('Медсестра')) continue;

            const exists = await checkExistingReminder(task.id);
            if (exists) continue;

            const patient = await findPatientByName(task.title);
            if (!patient) continue;

            const daysDiff = dayjs(task.date_start).startOf('day').diff(dayjs().startOf('day'), 'day');

            if (daysDiff === 3) {
                await sendReminder(bot, patient.user_id, patient, doctor.title, task.date_start, '3d', task.id);
            } else if (daysDiff === 1) {
                await sendReminder(bot, patient.user_id, patient, doctor.title, task.date_start, '1d', task.id);
            }
        }
    }
}

function handleReminderConfirm(bot) {
    bot.action(/confirm_reminder_(.+)/, async (ctx) => {
        await ctx.answerCbQuery();
        const scheduleId = ctx.match[1];
        const userId = ctx.from.id;

        await updateReminderAck(scheduleId, userId);
        await ctx.answerCbQuery('✅ Спасибо! Подтверждение получено.');
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    });
}

module.exports = { checkAndSendReminders, handleReminderConfirm };