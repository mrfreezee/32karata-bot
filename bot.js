// bot.js
const { Bot } = require('@maxhub/max-bot-api');
const config = require('./config');
const {
    handleStart,
    handleAgreeProcessing,
    handleContact,
    handleConfirmData,
    handleCancelAuth
} = require('./handlers/authHandlers');
const { handleHelp, handleCheck } = require('./handlers/commandHandlers');
const { handleReminderConfirm } = require('./handlers/reminderHandlers');
const { checkAndSendReminders } = require('./handlers/reminderHandlers');
const { getUnsentBonuses, markBonusAsNotified } = require('./services/clientService');
const https = require('https');
const { medCorePool } = require('./db');

let isInitialized = false;
let bot = null;
let reminderInterval = null;
let bonusCheckInterval = null;
const LOCATION = process.env.LOCATION

const BONUS_CHECK_INTERVAL = 10 * 60 * 1000; // 10 минут

// Создаем агент с правильными настройками
const agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    timeout: 120000,
    rejectUnauthorized: false
});

function createBot() {
    return new Bot(config.BOT_TOKEN, {
        api: {
            agent: agent,
            timeout: 120000,
            apiTimeout: 120000,
            apiTimeoutWebhook: 120000
        }
    });
}

function setupHandlers(botInstance) {
    if (!isInitialized) {
        handleStart(botInstance);
        handleAgreeProcessing(botInstance);
        handleContact(botInstance);
        handleConfirmData(botInstance);
        handleCancelAuth(botInstance);
        handleHelp(botInstance);
        handleCheck(botInstance);
        handleReminderConfirm(botInstance);
        isInitialized = true;
        console.log('✅ Обработчики зарегистрированы');
    }
}

async function checkAndSendBonuses() {
    if (!bot) {
        console.log('⚠️ Бот не инициализирован, пропускаем проверку бонусов');
        return;
    }

    console.log(`\n🎁 Проверка начисленных бонусов [${new Date().toLocaleString('ru-RU')}]`);

    try {
        const bonuses = await getUnsentBonuses();

        if (bonuses.length === 0) {
            console.log('   ⚠️ Нет новых начислений бонусов для отправки');
            return;
        }

        console.log(`   📊 Найдено ${bonuses.length} начислений для отправки`);

        let sentCount = 0;

        for (const bonus of bonuses) {
            try {
                const tgId = bonus.tg_id;
                const maxId = bonus.max_id;
                const userId = tgId || maxId;

                if (!userId) {
                    await markBonusAsNotified(bonus.id, 'No user ID');
                    continue;
                }

                const message = `🎉 Вам начислены бонусы!\n\n` +
                    `💰 Сумма начисления: ${bonus.bonus_amount} бонусов\n` +
                    `📅 Дата начисления: ${new Date(bonus.bonus_processed_at).toLocaleDateString('ru-RU')}\n`;

                await bot.api.sendMessageToUser(userId, message);

                await markBonusAsNotified(bonus.id);
                sentCount++;
                console.log(`   ✅ Отправлено уведомление для ${bonus.full_name} (${bonus.bonus_amount} бонусов)`);

            } catch (err) {
                console.error(`   ❌ Ошибка отправки для заказа ${bonus.order_id}:`, err.message);
                if (err.message.includes('chat not found') || err.message.includes('bot was blocked')) {
                    await markBonusAsNotified(bonus.id, err.message);
                }
            }
        }

        console.log(`   ✅ Отправлено уведомлений: ${sentCount}`);

    } catch (error) {
        console.error('❌ Ошибка при проверке бонусов:', error);
    }
}

const checkAndSendPayments = async () => {
    // console.log('🔍 [PAYMENT] Запуск проверки платежей...');
    try {
        const payments = await medCorePool.query(
    `SELECT * FROM payments 
     WHERE status = 'pending' 
     AND sent_at IS NULL 
     AND clinic_id = 3
     AND location = $1
     LIMIT 10`,
    [LOCATION]
);


        for (const payment of payments.rows) {
            console.log(`🔍 [PAYMENT] Обработка платежа ${payment.id}, max_id: ${payment.max_id}`);
            try {
                await bot.api.sendMessageToUser(
                    payment.max_id,
                    `💳 Оплата услуг клиники\n\n` +
                    `Сумма: ${Number(payment.amount).toLocaleString()} ₽\n\n` +
                    `Ссылка для оплаты: ${payment.payment_url}`
                );

                await medCorePool.query(
                    `UPDATE payments SET status = 'sent', sent_at = NOW() WHERE id = $1`,
                    [payment.id]
                );

                console.log(`✅ [PAYMENT] Отправлена ссылка на оплату для max_id ${payment.max_id}`);
            } catch (err) {
                // console.error(`❌ [PAYMENT] Ошибка отправки платежа ${payment.id}:`, err.message);
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    } catch (err) {
        console.error('❌ [PAYMENT] Ошибка при проверке платежей:', err);
    }
}

// Инициализация и запуск
function init() {
    console.log('🚀 Инициализация MAX бота...');

    bot = createBot();
    setupHandlers(bot);

    bot.start();
    console.log('🤖 MAX Бот успешно запущен!');

    // Запускаем проверку бонусов через 5 секунд
    setTimeout(() => {
        checkAndSendBonuses();
        bonusCheckInterval = setInterval(() => {
            checkAndSendBonuses();
        }, BONUS_CHECK_INTERVAL);
        console.log(`⏰ Интервал проверки бонусов: каждые ${BONUS_CHECK_INTERVAL / 1000 / 60} минут`);
    }, 5000);

    setTimeout(() => {
        checkAndSendPayments();
        setInterval(() => {
            checkAndSendPayments();
        }, 60 * 1000); // каждую минуту
        console.log(`⏰ Интервал проверки платежей: каждую минуту`);
    }, 10000);

    // Ежедневная проверка напоминаний в 9:00
    const dayjs = require('dayjs');
    const scheduleDailyCheck = () => {
        if (reminderInterval) {
            clearInterval(reminderInterval);
            reminderInterval = null;
        }

        const now = dayjs();
        const next9am = dayjs().hour(9).minute(0).second(0);
        let delay = next9am.diff(now);

        if (delay <= 0) {
            delay = dayjs().add(1, 'day').hour(9).minute(0).second(0).diff(now);
        }

        setTimeout(() => {
            if (bot) {
                checkAndSendReminders(bot).catch(console.error);
            }
            reminderInterval = setInterval(() => {
                if (bot) {
                    checkAndSendReminders(bot).catch(console.error);
                }
            }, 24 * 60 * 60 * 1000);
        }, delay);
    };

    scheduleDailyCheck();
}

// Обработка завершения
process.on('SIGINT', () => {
    console.log('🛑 Остановка MAX бота...');
    if (reminderInterval) clearInterval(reminderInterval);
    if (bonusCheckInterval) clearInterval(bonusCheckInterval);
    if (bot) bot.stop();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('🛑 Остановка MAX бота...');
    if (reminderInterval) clearInterval(reminderInterval);
    if (bonusCheckInterval) clearInterval(bonusCheckInterval);
    if (bot) bot.stop();
    process.exit(0);
});

// Запуск
init();