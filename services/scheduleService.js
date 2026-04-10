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
        return data.data || [];
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
        SELECT user_id, full_name, phone
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

module.exports = { getSchedule, findPatientByName };