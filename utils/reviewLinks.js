const clinicData = {
    // Москва
    mosc: {
        50: { // Москва (branch_id = 50)
            yandexLink: 'https://yandex.ru/maps/org/32_karata/88193360020/reviews/',
            gisLink: 'https://2gis.ru/moscow/firm/70000001079728378/tab/reviews'
        }
    },
    // Тольятти по branch_id
    tlt: {
        1: { // ПРЕМИУМ
            yandexLink: 'https://yandex.ru/maps/org/32_karata_premium/1150447332/reviews/',
            gisLink: 'https://2gis.ru/togliatti/firm/3096753025240814/tab/reviews'
        },
        2: { // МЕДИЦИНА
            yandexLink: 'https://yandex.ru/maps/org/32_karata_medicina/1287055257/reviews/',
            gisLink: 'https://2gis.ru/togliatti/firm/70000001019289550/tab/reviews'
        },
        3: { // ОПТИМА
            yandexLink: 'https://yandex.ru/maps/org/32_karata_optima/1109606156/reviews/',
            gisLink: 'https://2gis.ru/togliatti/firm/3096753024914266/tab/reviews'
        },
        4: { // СПОРТИВНАЯ
            yandexLink: 'https://yandex.ru/maps/org/32_karata_sportivnaya/35389863844/reviews/',
            gisLink: 'https://2gis.ru/togliatti/firm/70000001060198753/tab/reviews'
        }
    }
};

function getReviewLinks(location, branchId) {
    // Для Москвы
    if (location === 'mosc') {
        const branch = clinicData.mosc[branchId];
        if (branch) {
            return branch;
        }
        // Fallback для Москвы
        return clinicData.mosc[50];
    }
    
    // Для Тольятти
    if (location === 'tlt' && branchId) {
        const branch = clinicData.tlt[branchId];
        if (branch) {
            return branch;
        }
        // По умолчанию возвращаем ОПТИМУ
        return clinicData.tlt[3];
    }
    
    // Fallback
    return {
        yandexLink: 'https://yandex.ru/maps/org/32_karata/reviews/',
        gisLink: 'https://2gis.ru/togliatti/search/32%20%D0%BA%D0%B0%D1%80%D0%B0%D1%82%D0%B0/tab/reviews'
    };
}

module.exports = { getReviewLinks };