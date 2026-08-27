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
    
    const phoneVariants = [];
    
    if (cleanPhone.startsWith('7')) {
        phoneVariants.push(cleanPhone);
        phoneVariants.push('8' + cleanPhone.slice(1));
    } 
    else if (cleanPhone.startsWith('8')) {
        phoneVariants.push(cleanPhone);
        phoneVariants.push('7' + cleanPhone.slice(1));
    } 
    else if (cleanPhone.length === 10 && cleanPhone.startsWith('9')) {
        phoneVariants.push('7' + cleanPhone);
        phoneVariants.push('8' + cleanPhone);
    } 
    else {
        phoneVariants.push(cleanPhone);
    }

    const uniqueVariants = [...new Set(phoneVariants)];
    
    console.log(`📱 Поиск по номерам:`, uniqueVariants);

    for (const variant of uniqueVariants) {
        const url = `${API_CLIENT_URL}/api/client_by_phone?token=${API_TOKEN}&secret=${API_SECRET}&phone=${variant}`;
        
        try {
            const response = await fetch(url);
            const data = await response.json();

            if (data.status && data.data && Object.keys(data.data).length > 0) {
                const clients = Object.values(data.data);

                for (const client of clients) {
                    const clientId = client.id_client;
                    if (clientId) {
                        try {
                            const detailUrl = `${API_CLIENT_URL}/api/i/client?token=${API_TOKEN}&secret=${API_SECRET}&id=${clientId}`;
                            const detailResponse = await fetch(detailUrl);
                            const detailData = await detailResponse.json();
                            if (detailData.data) {
                                client.total_cash = Math.round(detailData.data.total_cash || 0);
                                // ✅ Добавляем date_of_first_appointment
                                client.date_of_first_appointment = detailData.data.date_of_first_appointment || null;
                            }
                        } catch (e) { }
                    }
                }

                console.log(`🔍 Найдено пациентов по номеру ${variant}: ${clients.length}`);
                return { success: true, clients };
            }
        } catch (error) {
            console.error(`Ошибка API для номера ${variant}:`, error.message);
        }
    }

    return { success: false, error: 'Пациент не найден' };
}


async function saveClientToDB(userId, clientData, phone, platform = 'max', invitedId = null, avatarUrl = null) {
    const cleanPhone = cleanPhoneNumber(phone);
    const messengerId = Number(userId);
    const clinicPersonId = clientData.id_client ? Number(clientData.id_client) : null;

    const idColumn = platform === 'telegram' ? 'tg_id'
        : platform === 'max' ? 'max_id'
            : 'vk_id';

    // ✅ Определяем branch_id в зависимости от LOCATION
    const location = process.env.LOCATION;
    const branchId = location === 'mosc' ? 50 : null;

    console.log('📝 saveClientToDB - параметры:', {
        messengerId, platform, idColumn, phone: cleanPhone,
        clientName: clientData.display_name, invitedId, avatarUrl, clinicPersonId,
        location, branchId
    });

    try {
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
            data_processing: client.data_processing,
            current_branch_id: client.branch_id
        });

        // Если ID для этой платформы не заполнен — добавляем
        if (!client[idColumn]) {
            console.log(`📱 Привязываем ${platform} ID ${messengerId} к существующей записи ${client.id}`);
            return await updateClientPlatformId(client.id, idColumn, messengerId, clientData, avatarUrl);
        }

        // Если ID уже заполнен и совпадает — обновляем данные
        if (client[idColumn] === messengerId) {
            console.log(`✅ ${platform} ID ${messengerId} уже привязан к записи ${client.id}, обновляем данные`);
            
            // ✅ Обновляем branch_id и location
            const totalCash = clientData.total_cash || 0;
            const result = await pool.query(
                `UPDATE public.client 
                 SET full_name = COALESCE($1, full_name),
                     avatar_url = COALESCE($2, avatar_url),
                     data_processing = true,
                     branch_id = $4,
                     location = $5,
                     total_cash = $6
                 WHERE id = $3
                 RETURNING *`,
                [clientData.display_name || client.full_name, avatarUrl, client.id, branchId, location, totalCash]
            );
            return result.rows[0];
        }

        // Если ID заполнен, но другим пользователем
        console.warn(`⚠️ Номер ${cleanPhone} уже привязан к ${idColumn}=${client[idColumn]}, а текущий ${idColumn}=${messengerId}`);

        const totalCash = clientData.total_cash || 0;
        const result = await pool.query(
            `UPDATE public.client 
             SET full_name = $1,
                 avatar_url = COALESCE($2, avatar_url),
                 data_processing = true,
                 branch_id = $4,
                 location = $5,
                 total_cash = $6
             WHERE id = $3
             RETURNING *`,
            [clientData.display_name || client.full_name, avatarUrl, client.id, branchId, location, totalCash]
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

    const isPrimary = !clientData.date_of_first_appointment;

    const finalInvitedId = (isPrimary && invitedId) ? Number(invitedId) : null;

    const location = process.env.LOCATION;
    const branchId = location === 'mosc' ? 50 : null;

    let welcomeBonus = 0;
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
            data_processing, branch_id, location, invited_id, invitation_date, avatar_url, total_cash,
            is_primary
        ) VALUES ($1, $2, $3, $4, NOW(), 'patient', $5, $6, true, $7, $8, true, $9, $10, $11, NOW(), $12, $13, $14)
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
        branchId,
        location,
        finalInvitedId,
        avatarUrl || null,
        totalCash,
        isPrimary
    ];

    try {
        const result = await pool.query(query, values);
        console.log(`✅ Новый клиент создан: ${idColumn}=${messengerId}, phone=${phone}, branch_id=${branchId}, бонус=${welcomeBonus}, total_cash=${totalCash}, is_primary=${isPrimary}, invited_id=${finalInvitedId || 'нет'}`);
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

        // ✅ Определяем branch_id в зависимости от LOCATION
        const location = process.env.LOCATION;
        const branchId = location === 'mosc' ? 50 : null;

        const result = await pool.query(
            `UPDATE public.client 
             SET ${idColumn} = $1,
                 full_name = COALESCE($2, full_name),
                 avatar_url = COALESCE($3, avatar_url),
                 data_processing = true,
                 is_new = false,
                 branch_id = $5,
                 location = $6,
                 total_cash = $7
             WHERE id = $4
             RETURNING *`,
            [messengerId, clientData.display_name, avatarUrl, clientId, branchId, location, totalCash]
        );

        console.log(`✅ ${idColumn} ${messengerId} привязан к записи ${clientId}, branch_id=${branchId}, total_cash=${totalCash}`);
        return result.rows[0];
    } catch (error) {
        console.error(`❌ Ошибка привязки ${idColumn}:`, error);
        return null;
    }
}



async function updateClientData(clientId, clientData, avatarUrl) {
    try {
        const totalCash = clientData.total_cash || 0;

        // ✅ Определяем branch_id в зависимости от LOCATION
        const location = process.env.LOCATION;
        const branchId = location === 'mosc' ? 50 : null;

        const result = await pool.query(
            `UPDATE public.client 
             SET full_name = COALESCE($1, full_name),
                 avatar_url = COALESCE($2, avatar_url),
                 data_processing = true,
                 is_new = false,
                 branch_id = $4,
                 location = $5,
                 total_cash = $6
             WHERE id = $3
             RETURNING *`,
            [clientData.display_name, avatarUrl, clientId, branchId, location, totalCash]
        );

        console.log(`✅ Данные клиента ${clientId} обновлены, branch_id=${branchId}, total_cash=${totalCash}`);
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

async function processPendingMailings(bot) {
    try {
        // Получаем все неотправленные рассылки
        const mailings = await medCorePool.query(`
            SELECT * FROM mailings 
            WHERE status = 'pending' 
            ORDER BY created_at ASC
        `);

        if (mailings.rows.length === 0) {
            console.log('📭 Нет pending рассылок');
            return;
        }

        console.log(`📨 Найдено ${mailings.rows.length} рассылок для отправки`);

        for (const mailing of mailings.rows) {
            console.log(`\n📧 Обработка рассылки #${mailing.id}`);
            console.log(`   Тип: ${mailing.recipient_type}`);
            console.log(`   Клиника: ${mailing.clinic_id}`);

            // Получаем получателей из таблицы mailing_recipients
            const recipients = await medCorePool.query(`
                SELECT 
                    id,
                    max_id,
                    full_name,
                    phone,
                    sent,
                    clinic_id
                FROM mailing_recipients
                WHERE mailing_id = $1 
                    AND sent = false
                    AND clinic_id = 3
                    AND max_id IS NOT NULL
            `, [mailing.id]);

            if (recipients.rows.length === 0) {
                console.log(`⚠️ Нет получателей для рассылки #${mailing.id}, помечаем как отправленную`);
                await medCorePool.query(`
                    UPDATE mailings 
                    SET status = 'sent', sent_at = NOW() 
                    WHERE id = $1
                `, [mailing.id]);
                continue;
            }

            console.log(`   Получателей: ${recipients.rows.length}`);

            let sent = 0;
            let failed = 0;

            // Формируем сообщение
            const fullMessage = mailing.message_title
                ? `*${mailing.message_title}*\n\n${mailing.message_text}`
                : mailing.message_text;

            for (const recipient of recipients.rows) {
                try {
                    await bot.api.sendMessageToUser(recipient.max_id, fullMessage, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    });

                    // Отмечаем как отправленное
                    await medCorePool.query(`
                        UPDATE mailing_recipients 
                        SET sent = true, sent_at = NOW() 
                        WHERE id = $1
                    `, [recipient.id]);

                    sent++;

                    if (sent % 10 === 0) {
                        console.log(`   ✅ Отправлено ${sent}/${recipients.rows.length}`);
                    }

                    await new Promise(r => setTimeout(r, 100));

                } catch (error) {
                    if (error.response?.error_code === 403) {
                        console.log(`   ❌ Пользователь ${recipient.max_id} заблокировал бота`);
                    } else {
                        console.error(`   ❌ Ошибка отправки ${recipient.max_id}:`, error.message);
                    }
                    failed++;
                }
            }

            // Обновляем статус рассылки
            await medCorePool.query(`
                UPDATE mailings 
                SET status = 'sent', 
                    sent_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
            `, [mailing.id]);

            console.log(`✅ Рассылка #${mailing.id} завершена: отправлено ${sent}, ошибок ${failed}`);
        }

    } catch (error) {
        console.error('❌ Ошибка в processPendingMailings:', error);
    }
}

async function processPermanentReminders(bot) {
    try {
        // Получаем активные постоянные рассылки, которые не остановлены
        const mailings = await medCorePool.query(`
            SELECT 
                pm.id,
                pm.message_title,
                pm.message_text,
                pm.clinic_id 
            FROM permanent_mailings pm
            WHERE pm.status = 'active' 
            AND pm.clinic_id = 3
                AND (pm.stopped IS NULL OR pm.stopped = false)
        `);

        if (mailings.rows.length === 0) {
            console.log('📭 Нет активных постоянных рассылок');
            return;
        }

        console.log(`📨 Найдено ${mailings.rows.length} активных постоянных рассылок`);

        for (const mailing of mailings.rows) {
            // Получаем получателей со статусом 'pending' для этой клиники
            const recipients = await medCorePool.query(`
                SELECT 
                    id,
                    full_name,
                    max_id,
                    clinic_id
                FROM permanent_mailing_recipients
                WHERE mailing_id = $1 
                    AND status = 'pending'
                    AND first_message_sent = false
                    AND max_id IS NOT NULL
                    AND clinic_id = $2
            `, [mailing.id, mailing.clinic_id]);

            if (recipients.rows.length === 0) {
                console.log(`   Нет получателей для рассылки #${mailing.id} (клиника ${mailing.clinic_id})`);
                continue;
            }

            console.log(`   Рассылка #${mailing.id} (клиника ${mailing.clinic_id}): ${recipients.rows.length} получателей`);

            let sent = 0;
            const firstMessage = mailing.message_title
                ? `*${mailing.message_title}*\n\n${mailing.message_text}`
                : mailing.message_text;

            for (const recipient of recipients.rows) {
                try {
                    await bot.api.sendMessageToUser(recipient.max_id, firstMessage, {
                        parse_mode: 'Markdown',
                        disable_web_page_preview: true
                    });

                    await medCorePool.query(`
                        UPDATE permanent_mailing_recipients 
                        SET first_message_sent = true,
                            first_message_sent_at = NOW(),
                            status = 'waiting_for_reminder'
                        WHERE id = $1
                    `, [recipient.id]);

                    sent++;
                    console.log(`   ✅ Отправлено ${recipient.full_name} (${recipient.max_id})`);
                    await new Promise(r => setTimeout(r, 100));

                } catch (error) {
                    console.error(`   ❌ Ошибка ${recipient.max_id}:`, error.message);
                }
            }

            console.log(`   Отправлено: ${sent}/${recipients.rows.length}`);
        }

    } catch (error) {
        console.error('❌ Ошибка в processPermanentReminders:', error);
    }
}

module.exports = {
    getClientByPhone,
    saveClientToDB,
    checkClientExists,
    findClientByPhone,
    markBonusAsNotified,
    getUnsentBonuses,
    processPendingMailings,
    processPermanentReminders
};