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
            const clients = Object.values(data.data);
            
            // Запрашиваем total_cash для каждого
            for (const client of clients) {
                const clientId = client.id_client;
                if (clientId) {
                    try {
                        const detailUrl = `${API_CLIENT_URL}/api/i/client?token=${API_TOKEN}&secret=${API_SECRET}&id=${clientId}`;
                        const detailResponse = await fetch(detailUrl);
                        const detailData = await detailResponse.json();
                        if (detailData.data) {
                            client.total_cash = detailData.data.total_cash || 0;
                        }
                    } catch (e) {}
                }
            }
            
            console.log(`🔍 Найдено пациентов: ${clients.length}`);
            return { success: true, clients };
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
    const clinicPersonId = clientData.id_client ? Number(clientData.id_client) : null;

    const idColumn = platform === 'telegram' ? 'tg_id'
        : platform === 'max' ? 'max_id'
            : 'vk_id';

    console.log('📝 saveClientToDB - параметры:', {
        messengerId, platform, idColumn, phone: cleanPhone,
        clientName: clientData.display_name, invitedId, avatarUrl, clinicPersonId
    });

    try {
        // Ищем по clinic_person_id, а не по телефону
        const existingClient = await pool.query(
            `SELECT id, tg_id, max_id, vk_id, full_name, phone, clinic_person_id,
                    data_processing, is_new, location, bonus_balance, invited_id, referral_bonus_granted
             FROM public.client 
             WHERE clinic_person_id = $1 AND location = $2
             LIMIT 1`,
            [clinicPersonId, process.env.LOCATION]
        );

        if (existingClient.rows.length === 0) {
            console.log('➕ Новая запись: создаем клиента');
            return await createNewClient(messengerId, idColumn, clientData, cleanPhone, invitedId, avatarUrl);
        }

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

        console.warn(`⚠️ Номер ${cleanPhone} уже привязан к ${idColumn}=${client[idColumn]}, а текущий ${idColumn}=${messengerId}`);

        const totalCash = clientData.total_cash || 0;

        const result = await pool.query(
            `UPDATE public.client 
     SET full_name = $1,
         avatar_url = COALESCE($2, avatar_url),
         data_processing = true,
         total_cash = $4
     WHERE id = $3
     RETURNING *`,
            [clientData.display_name || client.full_name, avatarUrl, client.id, totalCash]
        );

        return result.rows[0];

    } catch (error) {
        console.error('❌ Ошибка в saveClientToDB:', error);
        return null;
    }
}


async function createNewClient(messengerId, idColumn, clientData, phone, invitedId, avatarUrl) {
    const clientCode = await generateUniqueCode();
    const refCode = await generateUniqueCode();
    const clinicPersonId = clientData.id_client ? Number(clientData.id_client) : null;
    const totalCash = clientData.total_cash || 0;

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
            data_processing, branch_id, location, invited_id, invitation_date, avatar_url, total_cash
        ) VALUES ($1, $2, $3, $4, NOW(), 'patient', $5, $6, true, $7, $8, true, $9, $10, $11, NOW(), $12, $13)
        RETURNING *;
    `;

    const values = [
        messengerId,
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
        avatarUrl || null,
        totalCash
    ];

    try {
        const result = await pool.query(query, values);
        console.log(`✅ Новый клиент создан: ${idColumn}=${messengerId}, phone=${phone}, бонус=${welcomeBonus}, total_cash=${totalCash}`);
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
        const totalCash = clientData.total_cash || 0;

        const result = await pool.query(
            `UPDATE public.client 
             SET ${idColumn} = $1,
                 full_name = COALESCE($2, full_name),
                 avatar_url = COALESCE($3, avatar_url),
                 data_processing = true,
                 is_new = false,
                 total_cash = $5
             WHERE id = $4
             RETURNING *`,
            [messengerId, clientData.display_name, avatarUrl, clientId, totalCash]
        );

        console.log(`✅ ${idColumn} ${messengerId} привязан к записи ${clientId}, total_cash=${totalCash}`);
        return result.rows[0];
    } catch (error) {
        console.error(`❌ Ошибка привязки ${idColumn}:`, error);
        return null;
    }
}



async function updateClientData(clientId, clientData, avatarUrl) {
    try {
        const totalCash = clientData.total_cash || 0;

        const result = await pool.query(
            `UPDATE public.client 
             SET full_name = COALESCE($1, full_name),
                 avatar_url = COALESCE($2, avatar_url),
                 data_processing = true,
                 is_new = false,
                 total_cash = $4
             WHERE id = $3
             RETURNING *`,
            [clientData.display_name, avatarUrl, clientId, totalCash]
        );

        console.log(`✅ Данные клиента ${clientId} обновлены, total_cash=${totalCash}`);
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