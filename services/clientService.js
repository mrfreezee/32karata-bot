require('dotenv').config();
const { pool, medCorePool } = require('../db');
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

async function saveClientToDB(userId, clientData, phone, invitedId = null, avatarUrl = null) {
    const clientCode = await generateUniqueCode();
    const refCode = await generateUniqueCode();

    const clinicPersonId = clientData.id_client ? Number(clientData.id_client) : null;
    
    
    let welcomeBonus = 200;
    try {
        const bonusSettings = await medCorePool.query(
            `SELECT welcome_bonus FROM referral_settings WHERE clinic_id = 3 AND is_active = true LIMIT 1`
        );
        if (bonusSettings.rows.length > 0 && bonusSettings.rows[0].welcome_bonus) {
            welcomeBonus = bonusSettings.rows[0].welcome_bonus;
            console.log(`🎁 Welcome bonus from settings: ${welcomeBonus}`);
        } else {
            console.log(`⚠️ Welcome bonus not found in settings, using default: ${welcomeBonus}`);
        }
    } catch (error) {
        console.error('❌ Ошибка получения welcome_bonus из medCore:', error.message);
        console.log(`⚠️ Using default welcome bonus: ${welcomeBonus}`);
    }

    const query = `
        INSERT INTO public.client (
            user_id, full_name, phone, birth_date, reg_date, role, 
            client_code, ref_code, is_new, bonus_balance, clinic_person_id, 
            data_processing, branch_id, location, invited_id, invitation_date, avatar_url
        ) VALUES ($1, $2, $3, $4, NOW(), 'patient', $5, $6, true, $7, $8, true, $9, $10, $11, NOW(), $12)
        RETURNING *;
    `;

    const values = [
        Number(userId),
        clientData.display_name || null,
        phone,
        clientData.birthday || null,
        clientCode,
        refCode,
        welcomeBonus,
        clinicPersonId,
        null,
        process.env.LOCATION,
        invitedId ? Number(invitedId) : null,
        avatarUrl || null  // ← только это добавилось
    ];

    try {
        const result = await pool.query(query, values);
        console.log(`✅ Клиент сохранен в БД: ${userId} - ${clientData.display_name}, пригласил: ${invitedId || 'никто'}, бонус: ${welcomeBonus}`);
        return result.rows[0];
    } catch (error) {
        console.error('Ошибка сохранения клиента:', error);
        return null;
    }
}


async function checkClientExists(userId) {
    const result = await pool.query(
        `SELECT user_id, full_name, data_processing FROM public.client WHERE user_id = $1 AND location = $2`,
        [Number(userId), process.env.LOCATION]
    );
    return result.rows.length > 0 && result.rows[0].data_processing === true;
}


async function getUnsentBonuses() {
    try {
        const result = await medCorePool.query(`
            SELECT 
                sp.id,
                sp.order_id,
                sp.clinic_patient_id,
                sp.bonus_amount,
                sp.bonus_processed_at,
                p.tg_id,
                p.max_id,
                p.full_name
            FROM services_provided sp
            JOIN patients p ON p.clinic_patient_id::text = sp.clinic_patient_id AND p.clinic_id = 3
            WHERE sp.bonus_processed = true 
              AND sp.bonus_notified = false
              AND sp.bonus_amount > 0
              AND (p.tg_id IS NOT NULL OR p.max_id IS NOT NULL)
            ORDER BY sp.bonus_processed_at DESC
        `);
        
        return result.rows;
    } catch (error) {
        console.error('❌ Ошибка получения неотправленных бонусов:', error);
        return [];
    }
}

async function markBonusAsNotified(bonusId, error = null) {
    try {
        if (error) {
            await medCorePool.query(`
                UPDATE services_provided 
                SET bonus_notified = true,
                    bonus_notify_error = $1
                WHERE id = $2
            `, [error, bonusId]);
        } else {
            await medCorePool.query(`
                UPDATE services_provided 
                SET bonus_notified = true
                WHERE id = $1
            `, [bonusId]);
        }
        return true;
    } catch (error) {
        console.error('❌ Ошибка отметки бонуса как отправленного:', error);
        return false;
    }
}

module.exports = { getClientByPhone, saveClientToDB, checkClientExists, markBonusAsNotified, getUnsentBonuses };