const { Keyboard } = require('@maxhub/max-bot-api');
const dayjs = require('dayjs');
const { pool } = require('../db'); 
const { getSchedule, findPatientByName } = require('../services/scheduleService');
const { createReminder, updateReminderAck, checkExistingReminder } = require('../services/reminderService');

async function sendReminder(bot, chatId, patient, doctorName, appointmentDate, kind, scheduleId) {
    const date = dayjs(appointmentDate).format('DD.MM.YYYY');
    const hours = dayjs(appointmentDate).hour();
    const minutes = dayjs(appointmentDate).minute();

    let message = kind === '1d' 
        ? `⏰ Напоминание!\nЗавтра у вас приём у врача\n🗓 Дата: ${date}\n👨🏻‍⚕️ Врач: ${doctorName}\n🕒 Время: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
        : `📅 Предварительное напоминание\nЧерез 3 дня у вас приём у врача\n🗓 Дата: ${date}\n👨🏻‍⚕️ Врач: ${doctorName}\n🕒 Время: ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

    // В MAX Bot API кнопки создаются через Keyboard.inlineKeyboard
    const keyboard = Keyboard.inlineKeyboard([
        [
            Keyboard.button.callback('✅ Подтверждаю', `confirm_reminder_${scheduleId}`)
        ]
    ]);

    try {
        // В MAX Bot API клавиатура передается в attachments
        const sentMessage = await bot.api.sendMessageToUser(chatId, message, {
            attachments: [keyboard]
        });

        await createReminder(patient.user_id, scheduleId, kind, sentMessage.body.mid, chatId);
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

    console.log('SCHEDULE length:', schedule.length);
    if (!schedule.length) return;

    let doctorCount = 0;
    let taskCount = 0;
    let taskSkipped = 0;
    let reminderExists = 0;
    let patientNotFound = 0;
    let daysNotMatch = 0;
    let remindersSent = 0;

    for (const doctor of schedule) {
        doctorCount++;
        
        for (const task of doctor.tasks || []) {
            taskCount++;
            
            if (task.title === 'Резерв' || task.title.includes('Медсестра')) {
                taskSkipped++;
                continue;
            }

            const exists = await checkExistingReminder(task.id);
            if (exists) {
                reminderExists++;
                console.log(`      ⏭️ Напоминание уже отправлено для задачи ${task.id}`);
                continue;
            }

            const patient = await findPatientByName(task.title);
            if (!patient) {
                patientNotFound++;
                continue;
            }
            console.log(`      ✅ Пациент найден: ${patient.full_name} (${patient.user_id})`);

            const daysDiff = dayjs(task.date_start).startOf('day').diff(dayjs().startOf('day'), 'day');

            if (daysDiff === 3) {
                remindersSent++;
                console.log(`      📨 Отправляем напоминание за 3 дня`);
                await sendReminder(bot, patient.user_id, patient, doctor.title, task.date_start, '3d', task.id);
            } else if (daysDiff === 1) {
                remindersSent++;
                console.log(`      📨 Отправляем напоминание за 1 день`);
                await sendReminder(bot, patient.user_id, patient, doctor.title, task.date_start, '1d', task.id);
            } else {
                daysNotMatch++;
                console.log(`      ⏭️ Дней до записи ${daysDiff} - не отправляем`);
            }
        }
    }


}

async function handleReminderConfirm(bot) {
    bot.action(/confirm_reminder_(.+)/, async (ctx) => {
        const scheduleId = ctx.match[1];
        const userId = ctx.callback?.user?.user_id;

        console.log(`🔍 Подтверждение напоминания: scheduleId=${scheduleId}, userId=${userId}`);

        // Находим reminder по schedid, а не по id!
        const reminder = await pool.query(
            `SELECT id FROM reminders WHERE schedid = $1 AND is_active = true`,
            [scheduleId]
        );

        if (reminder.rows.length === 0) {
            console.log(`❌ Напоминание не найдено для scheduleId ${scheduleId}`);
            await ctx.reply('❌ Напоминание не найдено или уже обработано');
            return;
        }

        const reminderId = reminder.rows[0].id;
        await updateReminderAck(reminderId, userId);
        
        console.log(`✅ Подтверждено напоминание reminderId=${reminderId}`);
        await ctx.reply('✅ Спасибо! Подтверждение получено.');
    });
}

module.exports = { checkAndSendReminders, handleReminderConfirm };