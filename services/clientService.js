// services/clientService.js
require('dotenv').config();
const { pool, medCorePool } = require('../db');
const { cleanPhoneNumber } = require('../utils/phoneHelper');
const { generateUniqueCode } = require('../utils/codeGenerator');

const API_TOKEN = process.env.API_TOKEN;
const API_SECRET = process.env.API_SECRET;
const API_CLIENT_URL = process.env.API_CLIENT_URL;

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


async function saveClientToDB(userId, clientData, phone, platform = 'max', invitedId = null, avatarUrl = null) {
    const cleanPhone = cleanPhoneNumber(phone);
    const messengerId = Number(userId);
    
    // Определяем колонку для платформы
    const idColumn = platform === 'telegram' ? 'tg_id' 
                   : platform === 'max' ? 'max_id' 
                   : 'vk_id';
    
    console.log('📝 saveClientToDB - параметры:', {
        messengerId,
        platform,
        idColumn,
        phone: cleanPhone,
        clientName: clientData.display_name,
        invitedId,
        avatarUrl
    });

    try {
        // 1. Ищем существующую запись по номеру телефона
        const existingClient = await pool.query(
            `SELECT id, tg_id, max_id, vk_id, full_name, phone, clinic_person_id,
                    data_processing, is_new, location, bonus_balance, invited_id, referral_bonus_granted
             FROM public.client 
             WHERE phone = $1 AND location = $2
             LIMIT 1`,
            [cleanPhone, process.env.LOCATION]
        );

        // 2. Если запись НЕ найдена — создаем новую
        if (existingClient.rows.length === 0) {
            console.log('➕ Новая запись: создаем клиента');
            return await createNewClient(messengerId, idColumn, clientData, cleanPhone, invitedId, avatarUrl);
        }

        // 3. Запись найдена — проверяем и обновляем ID платформы если нужно
        const client = existingClient.rows[0];
        console.log('🔍 Найдена существующая запись:', {
            id: client.id,
            tg_id: client.tg_id,
            max_id: client.max_id,
            vk_id: client.vk_id,
            full_name: client.full_name,
            data_processing: client.data_processing
        });

        // Если ID для этой платформы не заполнен — добавляем
        if (!client[idColumn]) {
            console.log(`📱 Привязываем ${platform} ID ${messengerId} к существующей записи ${client.id}`);
            return await updateClientPlatformId(client.id, idColumn, messengerId, clientData, avatarUrl);
        }

        // Если ID уже заполнен и совпадает — обновляем данные
        if (client[idColumn] === messengerId) {
            console.log(`✅ ${platform} ID ${messengerId} уже привязан к записи ${client.id}, обновляем данные`);
            return await updateClientData(client.id, clientData, avatarUrl);
        }

        // Если ID заполнен, но другим пользователем
        console.warn(`⚠️ Номер ${cleanPhone} уже привязан к ${idColumn}=${client[idColumn]}, а текущий ${idColumn}=${messengerId}`);
        
        // Всё равно обновляем данные, но логируем конфликт
        const result = await pool.query(
            `UPDATE public.client 
             SET full_name = $1,
                 avatar_url = COALESCE($2, avatar_url),
                 data_processing = true
             WHERE id = $3
             RETURNING *`,
            [clientData.display_name || client.full_name, avatarUrl, client.id]
        );
        
        return result.rows[0];
        
    } catch (error) {
        console.error('❌ Ошибка в saveClientToDB:', error);
        return null;
    }
}

/**
 * Создание нового клиента
 */
async function createNewClient(messengerId, idColumn, clientData, phone, invitedId, avatarUrl) {
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
        }
    } catch (error) {
        console.error('❌ Ошибка получения welcome_bonus:', error.message);
    }

    const query = `
        INSERT INTO public.client (
            ${idColumn}, full_name, phone, birth_date, reg_date, role, 
            client_code, ref_code, is_new, bonus_balance, clinic_person_id, 
            data_processing, branch_id, location, invited_id, invitation_date, avatar_url
        ) VALUES ($1, $2, $3, $4, NOW(), 'patient', $5, $6, true, $7, $8, true, $9, $10, $11, NOW(), $12)
        RETURNING *;
    `;

    const values = [
        messengerId,                                 // $1 - platform_id
        clientData.display_name || null,             // $2 - full_name
        phone,                                       // $3 - phone
        clientData.birthday || null,                 // $4 - birth_date
        clientCode,                                  // $5 - client_code
        refCode,                                     // $6 - ref_code
        welcomeBonus,                                // $7 - bonus_balance
        clinicPersonId,                              // $8 - clinic_person_id
        null,                                        // $9 - branch_id
        process.env.LOCATION,                        // $10 - location
        invitedId ? Number(invitedId) : null,        // $11 - invited_id
        avatarUrl || null                            // $12 - avatar_url
    ];

    try {
        const result = await pool.query(query, values);
        console.log(`✅ Новый клиент создан: ${idColumn}=${messengerId}, phone=${phone}, бонус=${welcomeBonus}`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Ошибка создания клиента:', error);
        return null;
    }
}

/**
 * Привязка ID платформы к существующей записи
 */
async function updateClientPlatformId(clientId, idColumn, messengerId, clientData, avatarUrl) {
    try {
        const result = await pool.query(
            `UPDATE public.client 
             SET ${idColumn} = $1,
                 full_name = COALESCE($2, full_name),
                 avatar_url = COALESCE($3, avatar_url),
                 data_processing = true,
                 is_new = false
             WHERE id = $4
             RETURNING *`,
            [messengerId, clientData.display_name, avatarUrl, clientId]
        );
        
        console.log(`✅ ${idColumn} ${messengerId} привязан к записи ${clientId}`);
        return result.rows[0];
    } catch (error) {
        console.error(`❌ Ошибка привязки ${idColumn}:`, error);
        return null;
    }
}

/**
 * Обновление данных существующего клиента (когда ID платформы уже совпадает)
 */
async function updateClientData(clientId, clientData, avatarUrl) {
    try {
        const result = await pool.query(
            `UPDATE public.client 
             SET full_name = COALESCE($1, full_name),
                 avatar_url = COALESCE($2, avatar_url),
                 data_processing = true,
                 is_new = false
             WHERE id = $3
             RETURNING *`,
            [clientData.display_name, avatarUrl, clientId]
        );
        
        console.log(`✅ Данные клиента ${clientId} обновлены`);
        return result.rows[0];
    } catch (error) {
        console.error('❌ Ошибка обновления данных:', error);
        return null;
    }
}

/**
 * Проверка существования клиента по ID платформы
 */
async function checkClientExists(userId, platform = 'max') {
    const messengerId = Number(userId);
    const idColumn = platform === 'telegram' ? 'tg_id' 
                   : platform === 'max' ? 'max_id' 
                   : 'vk_id';
    
    const result = await pool.query(
        `SELECT id, tg_id, max_id, vk_id, full_name, data_processing, phone
         FROM public.client 
         WHERE ${idColumn} = $1 AND location = $2
         LIMIT 1`,
        [messengerId, process.env.LOCATION]
    );
    
    console.log('🔍 checkClientExists:', {
        platform,
        idColumn,
        messengerId,
        found: result.rows.length > 0,
        data_processing: result.rows[0]?.data_processing
    });
    
    return result.rows.length > 0 && result.rows[0].data_processing === true;
}

/**
 * Поиск клиента по номеру телефона
 */
async function findClientByPhone(phone) {
    const cleanPhone = cleanPhoneNumber(phone);
    
    const result = await pool.query(
        `SELECT id, tg_id, max_id, vk_id, full_name, phone, data_processing
         FROM public.client 
         WHERE phone = $1 AND location = $2
         LIMIT 1`,
        [cleanPhone, process.env.LOCATION]
    );
    
    return result.rows.length > 0 ? result.rows[0] : null;
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
                p.vk_id,
                p.full_name
            FROM services_provided sp
            JOIN patients p ON p.clinic_patient_id::text = sp.clinic_patient_id AND p.clinic_id = 3
            WHERE sp.bonus_processed = true 
              AND sp.bonus_notified = false
              AND sp.bonus_amount > 0
              AND (p.tg_id IS NOT NULL OR p.max_id IS NOT NULL OR p.vk_id IS NOT NULL)
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

module.exports = { 
    getClientByPhone, 
    saveClientToDB, 
    checkClientExists, 
    findClientByPhone,
    markBonusAsNotified, 
    getUnsentBonuses 
};