const config = require('../config');
const { pool } = require('../db');
const { normalizePatientName } = require('../utils/nameNormalizer');

const API_TOKEN = process.env.API_TOKEN
const API_SECRET = process.env.API_SECRET
const API_CLIENT_URL = process.env.API_CLIENT_URL


async function getSchedule(dateStart, dateEnd) {
    const url = `${API_CLIENT_URL}/api/mobile/schedule?token=${API_TOKEN}&secret=${API_SECRET}&date_start=${dateStart}&date_end=${dateEnd}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        const scheduleData = (data.data || []).map(doctor => {
            const tasks = (doctor.tasks || []).map(task => {
                // Ищем info блок, который охватывает время задачи
                const taskStart = task.date_start; // "2026-06-04 15:45:00"
                const taskEnd = task.date_end;     // "2026-06-04 16:30:00"
                
                const infoBlock = doctor.blocks?.find(b => {
                    if (b.type !== 'info') return false;
                    // Блок охватывает задачу, если задача внутри интервала блока
                    return b.date_start <= taskStart && b.date_end >= taskEnd;
                });

                // Fallback: если не нашли по времени — ищем по дате
                const fallbackBlock = !infoBlock 
                    ? doctor.blocks?.find(b => {
                        if (b.type !== 'info') return false;
                        const blockDate = b.date_start?.split(' ')[0];
                        const taskDate = taskStart?.split(' ')[0];
                        return blockDate === taskDate;
                    })
                    : null;

                const bestBlock = infoBlock || fallbackBlock || doctor.blocks?.find(b => b.type === 'info');
                
                const branchID = bestBlock?.branchID || null;
                const branchName = bestBlock?.branchName || null;

                return {
                    ...task,
                    branchID: task.branchID || branchID,
                    branchName: task.branchName || branchName
                };
            });

            return {
                ...doctor,
                tasks,
                branchID: doctor.blocks?.find(b => b.type === 'info')?.branchID || null,
                branchName: doctor.blocks?.find(b => b.type === 'info')?.branchName || null
            };
        });

        return scheduleData;
    } catch (error) {
        console.error('Ошибка получения расписания:', error);
        return [];
    }
}

async function findPatientByName(shortName) {
    const normalized = normalizePatientName(shortName);
    if (!normalized) return null;

    const { lastName, firstInitial, middleInitial } = normalized;

    const query = `
        SELECT id, tg_id, max_id, vk_id, full_name, phone
        FROM public.client 
        WHERE full_name ILIKE $1 AND data_processing = true
    `;

    const result = await pool.query(query, [`${lastName}%`]);

    for (const patient of result.rows) {
        const fullName = patient.full_name;
        const nameParts = fullName.split(' ');
        if (nameParts.length >= 2) {
            const firstName = nameParts[1];
            if (firstName && firstName.charAt(0).toUpperCase() === firstInitial.toUpperCase()) {
                if (middleInitial && nameParts.length >= 3) {
                    const middleName = nameParts[2];
                    if (middleName && middleName.charAt(0).toUpperCase() === middleInitial.toUpperCase()) {
                        return patient;
                    }
                } else if (!middleInitial) {
                    return patient;
                }
            }
        }
    }

    return null;
}

async function findPatientByClinicPersonId(clinicPersonId) {
    if (!clinicPersonId) return null;

    const query = `
        SELECT id, tg_id, max_id, vk_id, full_name, phone, clinic_person_id
        FROM public.client 
        WHERE clinic_person_id = $1 
          AND data_processing = true
        ORDER BY id
    `;

    const result = await pool.query(query, [String(clinicPersonId)]);

    if (result.rows.length > 0) {
        console.log(`   🔍 Найдено ${result.rows.length} пациентов с clinic_person_id=${clinicPersonId}`);
        return result.rows; // Возвращаем всех (может быть несколько с одним телефоном)
    }

    return null;
}

module.exports = { getSchedule, findPatientByName, findPatientByClinicPersonId };