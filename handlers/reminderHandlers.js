const { Keyboard } = require('@maxhub/max-bot-api');
const dayjs = require('dayjs');
const { pool } = require('../db');
const { getSchedule, findPatientByName, findPatientByClinicPersonId } = require('../services/scheduleService');
const { createReminder, updateReminderAck, checkExistingReminder } = require('../services/reminderService');

async function sendReminder(bot, chatId, patient, doctorName, appointmentDate, kind, scheduleId, branchId, clinicPatientId) {
    const date = dayjs(appointmentDate).format('DD.MM.YYYY');
    const hours = String(dayjs(appointmentDate).hour()).padStart(2, '0');
    const minutes = String(dayjs(appointmentDate).minute()).padStart(2, '0');
    const time = `${hours}:${minutes}`;

    let branchAddress = '';
    if (branchId) {
        try {
            const branch = await pool.query(
                `SELECT address FROM branches WHERE branch_id = $1 LIMIT 1`,
                [branchId]
            );
            if (branch.rows.length) {
                branchAddress = `\n📍 ${branch.rows[0].address}`;
            }
        } catch (e) {
            console.error('Ошибка получения адреса филиала:', e.message);
        }
    }

    let message;
    if (kind === 'today') {
        message = `⏰ Напоминание!\nСегодня у вас приём у врача\n🗓 Дата: ${date}\n👨🏻‍⚕️ Врач: ${doctorName}\n🕒 Время: ${time}${branchAddress}`;
    } else if (kind === '1d') {
        message = `⏰ Напоминание!\nЗавтра у вас приём у врача\n🗓 Дата: ${date}\n👨🏻‍⚕️ Врач: ${doctorName}\n🕒 Время: ${time}${branchAddress}`;
    } else {
        message = `📅 Предварительное напоминание\nЧерез 3 дня у вас приём у врача\n🗓 Дата: ${date}\n👨🏻‍⚕️ Врач: ${doctorName}\n🕒 Время: ${time}${branchAddress}`;
    }

    const keyboard = Keyboard.inlineKeyboard([
        [Keyboard.button.callback('✅ Подтверждаю', `confirm_reminder_${scheduleId}`)]
    ]);

    try {
        const sentMessage = await bot.api.sendMessageToUser(chatId, message, {
            attachments: [keyboard]
        });
        
        await createReminder(
            chatId,            
            'max',              
            scheduleId,          
            kind,                
            sentMessage.body.mid, 
            chatId,              
            doctorName,          
            appointmentDate,   
            time,              
            branchId,
            clinicPatientId         
        );
        
        console.log(`📨 Отправлено напоминание (${kind}) пациенту ${patient.full_name}, branchId: ${branchId || 'нет'}`);
    } catch (error) {
        console.error(`Ошибка отправки:`, error.message);
    }
}

async function checkAndSendReminders(bot) {
    const TEST_USER_ID = '186795504';
    
    const today = dayjs().format('YYYY-MM-DD');
    const dateEnd = dayjs().add(3, 'days').format('YYYY-MM-DD');

    console.log(`\n=== Проверка напоминаний ${today} - ${dateEnd} (тестовый режим: ${TEST_USER_ID}) ===\n`);

    const schedule = await getSchedule(today, dateEnd);

    for (const doctor of schedule) {
    for (const task of doctor.tasks || []) {
        if (task.id === 254178) {
            console.log('🔍 TASK 254178:', JSON.stringify(task, null, 2));
        }
    }
}

    console.log('SCHEDULE length:', schedule.length);
    if (!schedule.length) return;

    for (const doctor of schedule) {
        const infoBlock = doctor.blocks?.find(b => b.type === 'info');
        const doctorBranchID = infoBlock?.branchID || null;
        
        for (const task of doctor.tasks || []) {
            if (task.title === 'Резерв' || task.title.includes('Медсестра')) continue;



            const exists = await checkExistingReminder(task.id);
            if (exists) continue;

            // Ищем пациента по patientID (clinic_person_id)
            const clinicPersonId = task.patientID;
            if (!clinicPersonId) {
                continue;
            }

            const patients = await findPatientByClinicPersonId(clinicPersonId);
            if (!patients || patients.length === 0) {
                // console.log(`      ⚠️ Пациент не найден: clinic_person_id=${clinicPersonId}`);
                continue;
            }

            // Берём первого подходящего пациента с messengerId
            let patient = null;
            let messengerId = null;
            
            for (const p of patients) {
                const mid = p.max_id || p.tg_id || p.vk_id;
                if (mid) {
                    patient = p;
                    messengerId = mid;
                    break;
                }
            }

            if (!patient || !messengerId) {
                console.log(`      ⚠️ Нет messengerId для clinic_person_id=${clinicPersonId}`);
                continue;
            }

            // if (String(messengerId) !== TEST_USER_ID) {
            //     console.log(`      ⏭️ Пропускаем (не тестовый): ${patient.full_name}`);
            //     continue;
            // }

            const branchID = task.branchID || doctorBranchID;

            console.log(`      ✅ Пациент: ${patient.full_name} (clinic_person_id=${clinicPersonId}), branchID: ${branchID}`);

            const daysDiff = dayjs(task.date_start).startOf('day').diff(dayjs().startOf('day'), 'day');

            if (daysDiff === 0) {
                console.log(`      📨 Отправляем на сегодня`);
                await sendReminder(bot, messengerId, patient, doctor.title, task.date_start, 'today', task.id, branchID, clinicPersonId);
            } else if (daysDiff === 1) {
                console.log(`      📨 Отправляем за 1 день`);
                await sendReminder(bot, messengerId, patient, doctor.title, task.date_start, '1d', task.id, branchID, clinicPersonId);
            } else if (daysDiff === 3) {
                console.log(`      📨 Отправляем за 3 дня`);
                await sendReminder(bot, messengerId, patient, doctor.title, task.date_start, '3d', task.id, branchID, clinicPersonId);
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
            `SELECT id FROM reminders WHERE schedid = $1`,
            [scheduleId]
        );

        if (reminder.rows.length === 0) {
            console.log(`❌ Напоминание не найдено для scheduleId ${scheduleId}`);
            // await ctx.reply('❌ Напоминание не найдено или уже обработано');
            return;
        }

        const reminderId = reminder.rows[0].id;
        await updateReminderAck(reminderId, userId);

        console.log(`✅ Подтверждено напоминание reminderId=${reminderId}`);
        await ctx.reply('✅ Спасибо! Подтверждение получено.');
    });
}

module.exports = { checkAndSendReminders, handleReminderConfirm };