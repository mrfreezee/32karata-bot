require('dotenv').config();
const { pool } = require('../db');
const { cleanPhoneNumber } = require('../utils/phoneHelper');
const { generateUniqueCode } = require('../utils/codeGenerator');

const API_TOKEN = process.env.API_TOKEN
const API_SECRET = process.env.API_SECRET
const API_CLIENT_URL = process.env.API_CLIENT_URL

async function getClientByPhone(phone) {
    const cleanPhone = cleanPhoneNumber(phone);
    const url = `${API_CLIENT_URL}/api/client_by_phone?token=${API_TOKEN}&secret=${API_SECRET}&phone=${cleanPhone}`;

    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.status && data.data && Object.keys(data.data).length > 0) {
            const clientKey = Object.keys(data.data)[0];
            const client = data.data[clientKey];
            console.log('🔍 Найден клиент:', client.display_name);
            return { success: true, client };
        }
        return { success: false, error: 'Пациент не найден' };
    } catch (error) {
        console.error('Ошибка API:', error);
        return { success: false, error: 'Ошибка соединения' };
    }
}

async function saveClientToDB(userId, clientData, phone) {
    const clientCode = await generateUniqueCode();
    const refCode = await generateUniqueCode();

    const clinicPersonId = clientData.id_client ? Number(clientData.id_client) : null;

    const query = `
        INSERT INTO public.client (
            user_id, full_name, phone, birth_date, reg_date, role, 
            client_code, ref_code, is_new, bonus_balance, clinic_person_id, data_processing, branch_id, location
        ) VALUES ($1, $2, $3, $4, NOW(), 'patient', $5, $6, true, 200, $7, true, $8, $9)
        RETURNING *;
    `;

    const values = [
        Number(userId),      // $1
        clientData.display_name || null,  // $2
        phone,               // $3
        clientData.birthday || null,  // $4
        clientCode,          // $5
        refCode,             // $6
        clinicPersonId,      // $7
        null,               // $8 - branch_id
        process.env.LOCATION
    ];

    try {
        const result = await pool.query(query, values);
        console.log(`✅ Клиент сохранен в БД: ${userId} - ${clientData.display_name}`);
        return result.rows[0];
    } catch (error) {
        console.error('Ошибка сохранения клиента:', error);
        return null;
    }
}

async function checkClientExists(userId) {
    const result = await pool.query(
        `SELECT user_id, full_name, data_processing FROM public.client WHERE user_id = $1`,
        [Number(userId)]
    );
    return result.rows.length > 0 && result.rows[0].data_processing === true;
}

module.exports = { getClientByPhone, saveClientToDB, checkClientExists };