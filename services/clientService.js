const { pool } = require('../db');
const { cleanPhoneNumber } = require('../utils/phoneHelper');
const { generateUniqueCode } = require('../utils/codeGenerator');

const API_TOKEN = 'ff66ef3e-0ffb-49b5-a7c7-2b7659ae2a1e';
const API_SECRET = '9e27bda7406bf9f79154dbd8fc5d3a8c';
const API_CLIENT_URL = 'https://32karatatlt.dental-pro.online/api/client_by_phone';

async function getClientByPhone(phone) {
    const cleanPhone = cleanPhoneNumber(phone);
    const url = `${API_CLIENT_URL}?token=${API_TOKEN}&secret=${API_SECRET}&phone=${cleanPhone}`;

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
            client_code, ref_code, is_new, bonus_balance, clinic_person_id, data_processing
        ) VALUES ($1, $2, $3, $4, NOW(), 'patient', $5, $6, true, 200, $7, true)
        ON CONFLICT (user_id) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            phone = EXCLUDED.phone,
            birth_date = EXCLUDED.birth_date,
            clinic_person_id = EXCLUDED.clinic_person_id,
            data_processing = true
        RETURNING *;
    `;
    
    const values = [
        Number(userId),
        clientData.display_name || null,
        phone,
        clientData.birthday || null,
        clientCode,
        refCode,
        clinicPersonId
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