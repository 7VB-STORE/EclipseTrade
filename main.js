const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');
const request = require('request');

let mainWindow;

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// Утилита для безопасного JSON парсинга
function safeJsonParse(str, defaultValue = null) {
    try {
        return JSON.parse(str);
    } catch {
        return defaultValue;
    }
}

// Валидация данных аккаунта
function validateAccountData(account) {
    const errors = [];

    if (!account || typeof account !== 'object') {
        errors.push('Аккаунт должен быть объектом');
        return errors;
    }

    if (!account.login || typeof account.login !== 'string' || account.login.trim() === '') {
        errors.push('Логин обязателен и должен быть строкой');
    }

    if (!account.password || typeof account.password !== 'string') {
        errors.push('Пароль обязателен и должен быть строкой');
    }

    if (account.sharedSecret && typeof account.sharedSecret === 'string') {
        try {
            Buffer.from(account.sharedSecret, 'base64');
        } catch {
            errors.push('sharedSecret должен быть в формате base64');
        }
    }

    if (account.identitySecret && typeof account.identitySecret === 'string') {
        try {
            Buffer.from(account.identitySecret, 'base64');
        } catch {
            errors.push('identitySecret должен быть в формате base64');
        }
    }

    return errors;
}

// Временное хранилище сессий
const sessionCache = new Map();
const SESSION_CACHE_TTL = 10 * 60 * 1000; // 10 минут

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 850,
        resizable: false,
        maximizable: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false
        },
        icon: path.join(__dirname, 'logo', 'logo.png'),
        frame: true,
        backgroundColor: '#1a1a2e'
    });

    mainWindow.loadFile('index.html');
    mainWindow.setMenu(null);

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// Загрузка аккаунтов
function loadAccounts() {
    try {
        if (fs.existsSync(ACCOUNTS_FILE)) {
            const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
            const parsed = safeJsonParse(data, []);
            if (!Array.isArray(parsed)) {
                console.error('accounts.json не является массивом, создаём новый файл');
                return [];
            }
            return parsed;
        }
    } catch (err) {
        console.error('Ошибка загрузки аккаунтов:', err.message);
    }
    return [];
}

// Сохранение аккаунтов
function saveAccounts(accounts) {
    try {
        if (!Array.isArray(accounts)) {
            console.error('[saveAccounts] Попытка сохранить не массив аккаунтов');
            return false;
        }
        
        const jsonPath = ACCOUNTS_FILE;
        console.log(`[saveAccounts] Saving ${accounts.length} accounts to ${jsonPath}`);
        
        fs.writeFileSync(jsonPath, JSON.stringify(accounts, null, 2), 'utf8');
        
        // Проверяем что файл записался
        const saved = fs.readFileSync(jsonPath, 'utf8');
        const savedAccounts = JSON.parse(saved);
        console.log(`[saveAccounts] ✓ Saved successfully, accounts in file: ${savedAccounts.length}`);
        
        return true;
    } catch (err) {
        console.error('[saveAccounts] Error:', err.message);
        return false;
    }
}

// Аутентификация через steam-session (современный метод)
async function authenticateWithSteam(account) {
    return new Promise((resolve, reject) => {
        const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
        
        let timeout = setTimeout(() => {
            session.cancelLoginAttempt();
            reject(new Error('Таймаут аутентификации (60 сек)'));
        }, 60000);

        session.on('transport', (transport) => {
            console.log(`[Steam Session] Transport: ${transport}`);
        });

        session.on('debug', (message) => {
            // console.log(`[Steam Session Debug] ${message}`);
        });

        session.on('authenticating', () => {
            console.log('[Steam Session] Authenticating...');
        });

        session.on('authenticated', (details) => {
            console.log('[Steam Session] ✓ Authenticated!');
            clearTimeout(timeout);
            
            const refreshToken = session.refreshToken;
            const steamId = session.steamID;
            
            resolve({ session, refreshToken, steamId });
        });

        session.on('error', (err) => {
            console.error('[Steam Session] Error:', err);
            clearTimeout(timeout);
            reject(new Error(`Ошибка сессии: ${err.message}`));
        });

        session.on('expired', () => {
            console.log('[Steam Session] Session expired');
            clearTimeout(timeout);
            reject(new Error('Сессия истекла'));
        });

        // Начинаем аутентификацию
        session.startWithCredentials({
            accountName: account.login,
            password: account.password
        }).then((result) => {
            if (result.actionRequired) {
                console.log('[Steam Session] Action required:', result.validActions);

                // Если требуется 2FA и есть sharedSecret
                if (account.sharedSecret) {
                    try {
                        const sharedSecret = Buffer.from(account.sharedSecret, 'base64');
                        const code = SteamTotp.getAuthCode(sharedSecret);
                        console.log('[Steam Session] Submitting 2FA code:', code);
                        
                        // Игнорируем ошибки 429 от submitSteamGuardCode
                        session.submitSteamGuardCode(code).catch((err) => {
                            console.error('[Steam Session] submitSteamGuardCode error:', err.message);
                            if (!err.message.includes('429')) {
                                clearTimeout(timeout);
                                reject(new Error(`2FA ошибка: ${err.message}`));
                            }
                            // Иначе ждём authenticated событие
                        });
                    } catch (e) {
                        console.error('[Steam Session] 2FA generation error:', e);
                        clearTimeout(timeout);
                        reject(new Error('Неверный формат sharedSecret'));
                    }
                }
            }
        }).catch((err) => {
            clearTimeout(timeout);
            console.error('[Steam Session] startWithCredentials error:', err);

            let errorMsg = err.message;
            if (err.eresult !== undefined) {
                const eresultMessages = {
                    5: 'Неверный пароль',
                    7: 'Аккаунт не найден',
                    8: 'Неверный 2FA код',
                    15: 'Сервис Steam недоступен',
                    38: 'Слишком много запросов (Rate Limit)',
                    84: 'Слишком много попыток входа. Подождите 5-30 минут',
                    87: 'Временная блокировка входа'
                };
                errorMsg = eresultMessages[err.eresult] || `${err.message} (EResult: ${err.eresult})`;
            } else if (err.message.includes('429')) {
                errorMsg = 'Слишком много запросов к Steam (429). Подождите 1-2 минуты и попробуйте снова.';
            }
            reject(new Error(errorMsg));
        });
    });
}

// Получение инвентаря через Steam Web API с использованием steam-session
async function getInventory(account, appId, contextId, currency = '5') {
    if (!account || !account.login) {
        throw new Error('Неверные данные аккаунта');
    }

    if (!appId || !contextId) {
        throw new Error('Неверные параметры инвентаря (appId/contextId)');
    }

    console.log(`\n=== getInventory ===`);
    console.log(`Account: ${account.login}`);
    console.log(`AppID: ${appId}, ContextID: ${contextId}`);

    let session = null;
    let resolved = false;
    let manager = null;

    try {
        // Аутентификация через steam-session
        console.log('[getInventory] Starting Steam authentication...');
        const authResult = await authenticateWithSteam(account);
        session = authResult.session;
        
        console.log('[getInventory] Auth successful, SteamID:', authResult.steamId);
        const steamId64 = authResult.steamId.toString();

        // Получаем cookies из сессии
        const cookies = await session.getWebCookies();
        console.log('[getInventory] Web cookies received:', cookies.length);

        // Создаём TradeOfferManager для получения инвентаря
        manager = new TradeOfferManager({
            language: 'en',
            pollInterval: 5000,
            cancelTime: 86400000
        });

        // Устанавливаем cookies в manager
        await new Promise((resolve, reject) => {
            manager.setCookies(cookies, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        console.log('[getInventory] Cookies set to TradeOfferManager');

        // Получаем инвентарь через TradeOfferManager
        console.log('[getInventory] Getting inventory via TradeOfferManager...');
        
        const items = await new Promise((resolve, reject) => {
            manager.getInventoryContents(appId, contextId, true, (err, inventory) => {
                if (err) {
                    reject(new Error(`TradeOfferManager error: ${err.message}`));
                    return;
                }
                
                console.log('[getInventory] Raw inventory:', inventory);
                
                // Преобразуем в наш формат
                const formattedItems = inventory.map(item => ({
                    appid: item.appid,
                    contextid: item.contextid,
                    assetid: item.assetid,
                    amount: item.amount || 1,
                    classid: item.classid,
                    instanceid: item.instanceid,
                    market_hash_name: item.market_hash_name || item.name,
                    name: item.name,
                    icon_url: item.icon_url,
                    type: item.type,
                    tradable: item.tradable,
                    commodity: item.commodity
                }));
                
                resolve(formattedItems);
            });
        });

        console.log(`[getInventory] Loaded ${items.length} items`);

        // Получаем цены
        const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const itemsWithPrices = await getItemPrices(cookieHeader, items, appId, currency);
        
        resolved = true;
        return itemsWithPrices;

    } catch (err) {
        console.error('[getInventory] Error:', err.message);
        throw err;
    } finally {
        if (session && !resolved) {
            session.cancelLoginAttempt();
        }
        if (manager && !resolved) {
            manager.shutdown();
        }
    }
}

// Кэш цен (хранится в памяти + в файле)
const priceCache = new Map();
const PRICE_CACHE_TTL = 30 * 60 * 1000; // 30 минут
const PRICE_FILE = path.join(__dirname, 'prices_cache.json');

// Загрузка кэша цен из файла
function loadPriceCache() {
    try {
        if (fs.existsSync(PRICE_FILE)) {
            const data = fs.readFileSync(PRICE_FILE, 'utf8');
            const parsed = JSON.parse(data);
            // Загружаем только свежие записи (не старше 1 часа)
            const now = Date.now();
            for (const [key, value] of Object.entries(parsed)) {
                if (now - value.timestamp < 60 * 60 * 1000) {
                    priceCache.set(key, value);
                }
            }
            console.log(`[PriceCache] Loaded ${priceCache.size} items from file`);
        }
    } catch (err) {
        console.error('[PriceCache] Load error:', err.message);
    }
}

// Сохранение кэша цен в файл
function savePriceCache() {
    try {
        const cacheObj = {};
        for (const [key, value] of priceCache.entries()) {
            cacheObj[key] = value;
        }
        fs.writeFileSync(PRICE_FILE, JSON.stringify(cacheObj, null, 2), 'utf8');
        console.log(`[PriceCache] Saved ${priceCache.size} items to file`);
    } catch (err) {
        console.error('[PriceCache] Save error:', err.message);
    }
}

// Авто-сохранение кэша каждые 5 минут
setInterval(() => {
    if (priceCache.size > 0) {
        savePriceCache();
    }
}, 5 * 60 * 1000);

// Загружаем кэш при старте
loadPriceCache();

// Получение цен предметов (исправленная версия)
async function getItemPrices(cookieHeader, items, appId, currency = '5') {
    const prices = {};
    const uniqueItems = [];
    const now = Date.now();

    console.log(`[Prices] === getItemPrices ===`);
    console.log(`[Prices] CookieHeader length: ${cookieHeader?.length || 0}`);
    console.log(`[Prices] AppID: ${appId}, Currency: ${currency}`);
    console.log(`[Prices] Total items: ${items.length}`);

    // Очищаем старый кэш
    for (const [key, value] of priceCache.entries()) {
        if (now - value.timestamp > PRICE_CACHE_TTL) {
            priceCache.delete(key);
        }
    }

    items.forEach(item => {
        const name = item.market_hash_name;
        if (name && !uniqueItems.includes(name)) {
            uniqueItems.push(name);
        }
    });

    if (uniqueItems.length === 0) return items;

    console.log(`[Prices] Need prices for ${uniqueItems.length} items`);

    // Сначала проверяем кэш
    uniqueItems.forEach(name => {
        const cacheKey = `${appId}_${currency}_${name}`;
        const cached = priceCache.get(cacheKey);
        if (cached && (now - cached.timestamp < PRICE_CACHE_TTL)) {
            prices[name] = cached.price;
            console.log(`[Prices] [CACHED] ${name}: ${cached.price.lowest_price}`);
        }
    });

    const cachedCount = Object.keys(prices).length;
    const needFetch = uniqueItems.filter(name => !prices[name]);

    console.log(`[Prices] From cache: ${cachedCount}, Need fetch: ${needFetch.length}`);

    // Если есть что загрузить - загружаем все предметы
    if (needFetch.length > 0) {
        const itemsToFetch = needFetch; // Без ограничений

        for (let i = 0; i < itemsToFetch.length; i++) {
            const itemName = itemsToFetch[i];
            const cacheKey = `${appId}_${currency}_${itemName}`;

            try {
                const appName = appId === 730 ? '730' : appId === 440 ? '440' : '753';
                const url = `https://steamcommunity.com/market/priceoverview/?appid=${appName}&currency=${currency}&market_hash_name=${encodeURIComponent(itemName)}`;

                console.log(`[Prices] Fetching: ${itemName}`);
                console.log(`[Prices] URL: ${url}`);

                const priceData = await new Promise((resolve) => {
                    request.get({
                        url: url,
                        json: true,
                        timeout: 10000,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            'Cookie': cookieHeader,
                            'Referer': 'https://steamcommunity.com/market/'
                        }
                    }, (err, response, body) => {
                        console.log(`[Prices] Response ${itemName}:`, {
                            status: response?.statusCode,
                            success: body?.success,
                            successType: typeof body?.success,
                            lowest_price: body?.lowest_price,
                            price: body?.price,
                            err: err?.message,
                            fullBody: body
                        });

                        if (err) {
                            console.log(`[Prices] Request error for ${itemName}:`, err.message);
                            resolve(null);
                            return;
                        }
                        if (!body) {
                            console.log(`[Prices] Empty body for ${itemName}`);
                            resolve(null);
                            return;
                        }
                        // Steam может возвращать success: 1 (число) или success: true (булево)
                        if (body.success !== true && body.success !== 1) {
                            console.log(`[Prices] success !== true/1 for ${itemName}, body:`, body);
                            resolve(null);
                            return;
                        }
                        const priceValue = body.lowest_price || body.price;
                        if (priceValue) {
                            resolve({
                                lowest_price: priceValue,
                                volume: body.volume ? parseInt(body.volume.replace(/,/g, '')) : 0,
                                median_price: body.median_price || body.price || null
                            });
                        } else {
                            console.log(`[Prices] No price value for ${itemName}`);
                            resolve(null);
                        }
                    });
                });

                if (priceData) {
                    prices[itemName] = priceData;
                    priceCache.set(cacheKey, { price: priceData, timestamp: now });
                    console.log(`[Prices] ✓ ${itemName}: ${priceData.lowest_price}`);
                } else {
                    console.log(`[Prices] ✗ ${itemName}: No price`);
                }
            } catch (err) {
                console.error(`[Prices] Error for ${itemName}:`, err.message);
            }

            // Задержка между запросами
            if (i < itemsToFetch.length - 1) {
                await new Promise(r => setTimeout(r, 3000));
            }
        }

        savePriceCache();
    }

    console.log(`[Prices] Got prices for ${Object.keys(prices).length}/${uniqueItems.length} items`);

    // Возвращаем items с ценами
    return items.map(item => ({
        ...item,
        price: prices[item.market_hash_name] || null
    }));
}

// Отправка трейда
async function sendTrade(account, tradeLink, appId, contextId, identitySecret, itemsToSend = null) {
    if (!account || !account.login) throw new Error('Неверные данные аккаунта');
    if (!tradeLink || typeof tradeLink !== 'string') throw new Error('Неверная ссылка на трейд');
    if (!identitySecret || identitySecret.trim() === '') throw new Error('Отсутствует Identity Secret');
    if (!appId || !contextId) throw new Error('Неверные параметры инвентаря');

    console.log('\n=== sendTrade ===');
    console.log('Account:', account.login);
    console.log('Items to send:', itemsToSend ? itemsToSend.length : 'all');

    const SteamUser = require('steam-user');
    const SteamCommunity = require('steamcommunity');
    const TradeOfferManager = require('steam-tradeoffer-manager');
    const SteamTotp = require('steam-totp');

    const client = new SteamUser();
    const community = new SteamCommunity();
    const manager = new TradeOfferManager({
        steam: client,
        community: community,
        language: 'en',
        pollInterval: 5000
    });

    let resolved = false;

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            if (!resolved) {
                client.logOff();
                reject(new Error('Таймаут (120 сек)'));
            }
        }, 120000);

        client.on('loggedOn', () => {
            console.log('[sendTrade] Logged in');
            client.setPersona(SteamUser.EPersonaState.Online);
        });

        client.on('steamGuard', (domain, callback) => {
            console.log('[sendTrade] Steam Guard');
            if (account.sharedSecret) {
                const sharedSecret = Buffer.from(account.sharedSecret, 'base64');
                const code = SteamTotp.getAuthCode(sharedSecret);
                console.log('[sendTrade] 2FA code:', code);
                callback(code);
            } else {
                clearTimeout(timeout);
                resolved = true;
                client.logOff();
                reject(new Error('Нужен sharedSecret'));
            }
        });

        client.on('webSession', (sessionID, cookies) => {
            console.log('[sendTrade] Web session, cookies:', cookies.length);

            manager.setCookies(cookies, (err) => {
                if (err) {
                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();
                    reject(err);
                    return;
                }
                community.setCookies(cookies);

                console.log('[sendTrade] Getting inventory...');
                manager.getInventoryContents(appId, contextId, true, (err, inventory) => {
                    if (err) {
                        console.log('[sendTrade] Inventory error:', err.message);
                        inventory = [];
                    }

                    console.log('[sendTrade] Found', inventory.length, 'items');

                    if (inventory.length === 0) {
                        clearTimeout(timeout);
                        resolved = true;
                        client.logOff();
                        resolve({ status: 'sent', offerId: null, itemsCount: 0, message: 'Инвентарь пуст' });
                        return;
                    }

                    const offer = manager.createOffer(tradeLink);

                    // Если указаны конкретные предметы для отправки
                    if (itemsToSend && itemsToSend.length > 0) {
                        console.log('[sendTrade] Filtering items by selection:', itemsToSend);
                        
                        // Фильтруем инвентарь по выбранным assetid
                        const selectedItems = inventory.filter(item => itemsToSend.includes(item.assetid));
                        
                        console.log('[sendTrade] Selected items count:', selectedItems.length);
                        
                        if (selectedItems.length === 0) {
                            clearTimeout(timeout);
                            resolved = true;
                            client.logOff();
                            reject(new Error('Выбранные предметы не найдены в инвентаре'));
                            return;
                        }

                        selectedItems.forEach(item => offer.addMyItem(item));
                    } else {
                        // Отправляем все предметы
                        inventory.forEach(item => offer.addMyItem(item));
                    }

                    offer.send((err, result) => {
                        if (err) {
                            console.error('[sendTrade] Offer send error:', err.message);
                            clearTimeout(timeout);
                            resolved = true;
                            client.logOff();
                            reject(err);
                            return;
                        }

                        console.log('[sendTrade] Offer sent:', offer.id, 'state:', offer.state, 'result:', result);

                        // Если трейд отправлен успешно (не требует подтверждения)
                        if (offer.state === 1) { // Active
                            console.log('[sendTrade] ✓ Offer accepted automatically');
                            clearTimeout(timeout);
                            resolved = true;
                            client.logOff();
                            resolve({ status: 'sent', offerId: offer.id, itemsCount: offer.itemsToGive.length });
                            return;
                        }

                        // Если трейд требует подтверждения (pending)
                        console.log('[sendTrade] Trade needs confirmation, offer ID:', offer.id);

                        // Ждём 2 секунды перед подтверждением (Steam требует задержку)
                        setTimeout(() => {
                            console.log('[sendTrade] Attempting confirmation with identitySecret...');

                            // Функция подтверждения с retry
                            const tryConfirm = (attempt) => {
                                if (attempt > 3) {
                                    clearTimeout(timeout);
                                    resolved = true;
                                    client.logOff();
                                    reject(new Error('Не удалось подтвердить трейд после 3 попыток. Подтвердите вручную!'));
                                    return;
                                }

                                console.log(`[sendTrade] Confirmation attempt ${attempt}/3...`);

                                community.acceptConfirmationForObject(identitySecret, offer.id, (err) => {
                                    if (err) {
                                        console.error(`[sendTrade] Confirmation attempt ${attempt} failed:`, err.message);

                                        if (err.message.includes('No confirmation') || err.message.includes('not found')) {
                                            // Трейда ещё нет в списке подтверждений, ждём
                                            setTimeout(() => tryConfirm(attempt + 1), 2000);
                                        } else {
                                            // Другая ошибка
                                            clearTimeout(timeout);
                                            resolved = true;
                                            client.logOff();
                                            reject(new Error(err.message + '. Подтвердите вручную!'));
                                        }
                                        return;
                                    }

                                    console.log('[sendTrade] ✓ Confirmation successful!');
                                    clearTimeout(timeout);
                                    resolved = true;
                                    client.logOff();
                                    resolve({ status: 'sent', offerId: offer.id, itemsCount: offer.itemsToGive.length });
                                });
                            };

                            tryConfirm(1);
                        }, 2000);
                    });
                });
            });
        });

        client.on('error', (err) => {
            console.error('[sendTrade] Error:', err.message);
            if (!resolved) {
                clearTimeout(timeout);
                resolved = true;
                client.logOff();
                reject(err);
            }
        });

        console.log('[sendTrade] Logging in...');
        const logOnOptions = {
            accountName: account.login,
            password: account.password
        };
        if (account.sharedSecret) {
            logOnOptions.twoFactorCode = SteamTotp.getAuthCode(Buffer.from(account.sharedSecret, 'base64'));
        }
        client.logOn(logOnOptions);
    });
}

// Обработчики IPC
ipcMain.handle('get-accounts', () => {
    return loadAccounts();
});

ipcMain.handle('add-account', (event, account) => {
    try {
        const validationErrors = validateAccountData(account);
        if (validationErrors.length > 0) {
            return {
                success: false,
                error: validationErrors.join('; ')
            };
        }

        const accounts = loadAccounts();
        
        // Нормализуем логин (приводим к нижнему регистру для сравнения)
        const normalizedLogin = account.login.toLowerCase().trim();
        const existingIndex = accounts.findIndex(a => a.login.toLowerCase().trim() === normalizedLogin);

        if (existingIndex !== -1) {
            // Объединяем данные: сохраняем старые + добавляем новые поля
            accounts[existingIndex] = {
                ...accounts[existingIndex],  // Сохраняем старые данные
                ...account                   // Обновляем новыми
            };
            console.log(`[add-account] Merged account: ${account.login}`);
        } else {
            // Добавляем новый
            accounts.push(account);
            console.log(`[add-account] Added new account: ${account.login}`);
        }

        if (!saveAccounts(accounts)) {
            return { success: false, error: 'Ошибка сохранения' };
        }

        console.log(`[add-account] Total accounts: ${accounts.length}`);
        return { success: true, accounts };
    } catch (err) {
        console.error('Add account error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('remove-account', (event, index) => {
    try {
        const accounts = loadAccounts();
        if (index < 0 || index >= accounts.length) {
            return { success: false, error: 'Неверный индекс' };
        }

        accounts.splice(index, 1);

        if (!saveAccounts(accounts)) {
            return { success: false, error: 'Ошибка сохранения' };
        }

        return { success: true, accounts };
    } catch (err) {
        console.error('Remove account error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('select-file', async (event, fileType) => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: fileType === 'maFiles' ? ['openDirectory'] : ['openFile'],
            filters: fileType === 'txt' ? [{ name: 'Text Files', extensions: ['txt'] }] : undefined
        });

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }

        return result.filePaths[0];
    } catch (err) {
        console.error('Select file error:', err.message);
        return null;
    }
});

ipcMain.handle('import-acc-txt', async (event, filePath) => {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n').filter(line => line.trim());

        const accounts = loadAccounts();
        let added = 0;
        let updated = 0;
        let errors = 0;
        const processedLogins = new Set();

        for (const line of lines) {
            const parts = line.split(':');
            if (parts.length >= 2) {
                const accountData = {
                    login: parts[0].trim(),
                    password: parts[1].trim(),
                    sharedSecret: parts[2]?.trim() || '',
                    identitySecret: parts[3]?.trim() || ''
                };

                const normalizedLogin = accountData.login.toLowerCase().trim();
                
                if (processedLogins.has(normalizedLogin)) {
                    console.log(`[import-acc-txt] Skipping duplicate: ${accountData.login}`);
                    continue;
                }
                processedLogins.add(normalizedLogin);

                const existingIndex = accounts.findIndex(a => a.login.toLowerCase().trim() === normalizedLogin);
                if (existingIndex !== -1) {
                    // ОБЪЕДИНЯЕМ данные
                    accounts[existingIndex] = {
                        login: accounts[existingIndex].login,
                        password: accountData.password || accounts[existingIndex].password,
                        sharedSecret: accountData.sharedSecret || accounts[existingIndex].sharedSecret,
                        identitySecret: accountData.identitySecret || accounts[existingIndex].identitySecret
                    };
                    updated++;
                    console.log(`[import-acc-txt] Merged: ${accountData.login}`);
                } else {
                    accounts.push(accountData);
                    added++;
                    console.log(`[import-acc-txt] Added: ${accountData.login}`);
                }
            } else {
                errors++;
            }
        }

        if (!saveAccounts(accounts)) {
            return { success: false, error: 'Ошибка сохранения' };
        }

        console.log(`[import-acc-txt] Done: ${added} added, ${updated} updated, ${errors} errors`);
        return { success: true, accounts, added, updated, errors };
    } catch (err) {
        console.error('Import acc.txt error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('import-mafiles', async (event, folderPath) => {
    try {
        const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.maFile'));

        const accounts = loadAccounts();
        let added = 0;
        let updated = 0;
        let fileErrors = 0;

        for (const file of files) {
            try {
                const filePath = path.join(folderPath, file);
                const content = fs.readFileSync(filePath, 'utf8');
                const maFile = JSON.parse(content);

                if (!maFile.account_name || !maFile.shared_secret) {
                    fileErrors++;
                    console.log(`[import-mafiles] Invalid file: ${file}`);
                    continue;
                }

                const maLogin = maFile.account_name.toLowerCase().trim();
                const maSharedSecret = maFile.shared_secret;
                const maIdentitySecret = maFile.identity_secret || '';
                const maPassword = maFile.password || '';

                // Ищем аккаунт в accounts.json по логину
                const existingIndex = accounts.findIndex(a => a.login.toLowerCase().trim() === maLogin);
                
                if (existingIndex !== -1) {
                    // НАШЛИ СУЩЕСТВУЮЩИЙ — объединяем данные
                    accounts[existingIndex] = {
                        login: accounts[existingIndex].login,  // Оставляем логин из accounts.json
                        password: accounts[existingIndex].password || maPassword,  // Приоритет accounts.json
                        sharedSecret: maSharedSecret,  // Берём из maFile
                        identitySecret: maIdentitySecret  // Берём из maFile
                    };
                    updated++;
                    console.log(`[import-mafiles] Merged: ${maLogin} (pass: ${accounts[existingIndex].password ? '✓' : '✗'}, secrets: ✓)`);
                } else {
                    // НЕ НАШЛИ — создаём новый только из maFile
                    accounts.push({
                        login: maFile.account_name,
                        password: maPassword,
                        sharedSecret: maSharedSecret,
                        identitySecret: maIdentitySecret
                    });
                    added++;
                    console.log(`[import-mafiles] Added from maFile: ${maLogin}`);
                }
            } catch (err) {
                console.error(`[import-mafiles] Error reading ${file}:`, err.message);
                fileErrors++;
            }
        }

        if (!saveAccounts(accounts)) {
            return { success: false, error: 'Ошибка сохранения' };
        }

        console.log(`[import-mafiles] Done: ${added} added, ${updated} updated, ${fileErrors} errors`);
        console.log(`[import-mafiles] Total accounts in accounts.json: ${accounts.length}`);
        return { success: true, accounts, added, updated, fileErrors };
    } catch (err) {
        console.error('Import maFiles error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-inventory', async (event, account, appId, contextId, currency = '5') => {
    try {
        const items = await getInventory(account, appId, contextId, currency);
        return { success: true, items };
    } catch (err) {
        console.error('Get inventory error:', err.message);
        return { success: false, error: err.message };
    }
});

ipcMain.handle('send-trade', async (event, account, tradeLink, appId, contextId, identitySecret, itemsToSend = null) => {
    try {
        const result = await sendTrade(account, tradeLink, appId, contextId, identitySecret, itemsToSend);
        return { success: true, ...result };
    } catch (err) {
        console.error('Send trade error:', err.message);
        return { success: false, error: err.message };
    }
});

// Получение трейд-ссылки
ipcMain.handle('get-trade-link', async (event, account) => {
    try {
        console.log('\n=== get-trade-link ===');
        console.log('Account:', account.login);

        const SteamUser = require('steam-user');
        const SteamCommunity = require('steamcommunity');
        const SteamTotp = require('steam-totp');

        const client = new SteamUser();
        const community = new SteamCommunity();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.logOff();
                reject(new Error('Таймаут (60 сек)'));
            }, 60000);

            let resolved = false;

            client.on('loggedOn', () => {
                console.log('[get-trade-link] Logged in');
                client.setPersona(SteamUser.EPersonaState.Online);
            });

            client.on('steamGuard', (domain, callback) => {
                console.log('[get-trade-link] Steam Guard');
                if (account.sharedSecret) {
                    const sharedSecret = Buffer.from(account.sharedSecret, 'base64');
                    const code = SteamTotp.getAuthCode(sharedSecret);
                    console.log('[get-trade-link] 2FA code:', code);
                    callback(code);
                } else {
                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();
                    resolve({ success: false, error: 'Нужен sharedSecret' });
                }
            });

            client.on('webSession', async (sessionID, cookies) => {
                console.log('[get-trade-link] Web session');
                community.setCookies(cookies);

                try {
                    // Получаем HTML страницы трейдов
                    const html = await new Promise((resolve, reject) => {
                        community.httpRequestGet(
                            'https://steamcommunity.com/my/tradeoffers/privacy',
                            (err, response, body) => {
                                if (err) reject(err);
                                else resolve(body);
                            }
                        );
                    });

                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();

                    // Извлекаем трейд-ссылку через data-attribute
                    // <input type="text" id="trade_offer_access_url" value="https://..." />
                    const match = html.match(/id="trade_offer_access_url"[^>]*value="([^"]+)"/);

                    if (match && match[1]) {
                        const tradeUrl = match[1].replace(/&amp;/g, '&');
                        console.log('[get-trade-link] Trade URL:', tradeUrl);
                        resolve({ success: true, tradeLink: tradeUrl });
                    } else {
                        console.error('[get-trade-link] Trade URL not found in page');
                        console.log('[get-trade-link] HTML snippet:', html.substring(html.indexOf('trade_offer_access_url') - 50, html.indexOf('trade_offer_access_url') + 200));
                        resolve({
                            success: false,
                            error: 'Не удалось найти трейд-ссылку. Убедитесь, что трейды открыты.'
                        });
                    }
                } catch (err) {
                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();
                    console.error('[get-trade-link] Error:', err.message);
                    resolve({ success: false, error: err.message });
                }
            });

            client.on('error', (err) => {
                console.error('[get-trade-link] Error:', err.message);
                if (!resolved) {
                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();
                    resolve({ success: false, error: err.message });
                }
            });

            console.log('[get-trade-link] Logging in...');
            const logOnOptions = {
                accountName: account.login,
                password: account.password
            };
            if (account.sharedSecret) {
                logOnOptions.twoFactorCode = SteamTotp.getAuthCode(Buffer.from(account.sharedSecret, 'base64'));
            }
            client.logOn(logOnOptions);
        });
    } catch (err) {
        console.error('Get trade link error:', err.message);
        return { success: false, error: err.message };
    }
});

// Генерация 2FA кода
ipcMain.handle('generate-2fa-code', (event, sharedSecret) => {
    try {
        const SteamTotp = require('steam-totp');
        const sharedSecretBuffer = Buffer.from(sharedSecret, 'base64');
        const code = SteamTotp.getAuthCode(sharedSecretBuffer);
        const timeLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
        return { success: true, code, timeLeft };
    } catch (err) {
        console.error('Generate 2FA error:', err.message);
        return { success: false, error: err.message };
    }
});

// Получение входящих трейдов через прямой HTTP запрос (как в ASF)
ipcMain.handle('get-incoming-trades', async (event, account) => {
    try {
        console.log('\n=== get-incoming-trades ===');
        console.log('Account:', account.login);

        const SteamUser = require('steam-user');
        const SteamCommunity = require('steamcommunity');
        const SteamTotp = require('steam-totp');
        const request = require('request');

        const client = new SteamUser();
        const community = new SteamCommunity();

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                client.logOff();
                resolve({ success: false, error: 'Таймаут (60 сек)', trades: [] });
            }, 60000);

            let resolved = false;
            let sessionID = null;
            let cookieHeader = null;
            let steamId64 = null;

            const finish = (result) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    client.logOff();
                    resolve(result);
                }
            };

            client.on('loggedOn', () => {
                console.log('[get-incoming-trades] Logged in');
                client.setPersona(SteamUser.EPersonaState.Online);
            });

            client.on('steamGuard', (domain, callback) => {
                console.log('[get-incoming-trades] Steam Guard');
                if (account.sharedSecret) {
                    const sharedSecret = Buffer.from(account.sharedSecret, 'base64');
                    const code = SteamTotp.getAuthCode(sharedSecret);
                    console.log('[get-incoming-trades] 2FA code:', code);
                    callback(code);
                } else {
                    finish({ success: false, error: 'Нужен sharedSecret', trades: [] });
                }
            });

            client.on('webSession', (sessionID_, cookies) => {
                console.log('[get-incoming-trades] Web session received, cookies:', cookies.length);
                sessionID = sessionID_;
                
                // Устанавливаем cookies в community для получения дополнительных cookies
                community.setCookies(cookies);
                
                // Формируем Cookie header
                cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
                console.log('[get-incoming-trades] Cookie header length:', cookieHeader.length);

                // Получаем Steam64 ID из клиента
                steamId64 = client.steamID.getSteamID64();
                console.log('[get-incoming-trades] Steam64 ID:', steamId64);

                // Пробуем получить трейды через JSON API с cookies от community
                const url = `https://steamcommunity.com/tradeoffer/received/offerlist/json`;
                
                console.log('[get-incoming-trades] Fetching JSON API:', url);
                
                // Делаем запрос через community.httpRequestGet
                community.httpRequestGet(url, (err, response, body) => {
                    if (err) {
                        console.error('[get-incoming-trades] Community API error:', err.message);
                    }
                    
                    // Пробуем распарсить JSON
                    try {
                        const apiBody = JSON.parse(body);
                        
                        if (apiBody && apiBody.trade_offers_received && apiBody.trade_offers_received.length > 0) {
                            console.log('[get-incoming-trades] API received:', apiBody.trade_offers_received.length, 'trades');
                            
                            const trades = apiBody.trade_offers_received.map(offer => ({
                                id: offer.trade_offer_id.toString(),
                                partner: offer.account_id_other.toString(),
                                partnerSteamId64: offer.steamid_other || offer.account_id_other.toString(),
                                state: offer.state,
                                stateName: getOfferStateName(offer.state),
                                itemsToReceive: (offer.items_to_receive || []).map(item => ({
                                    assetid: item.assetid,
                                    classid: item.classid,
                                    instanceid: item.instanceid,
                                    amount: item.amount || 1,
                                    market_hash_name: item.market_hash_name || item.name,
                                    name: item.name,
                                    icon_url: item.icon_url,
                                    appid: item.appid,
                                    contextid: item.contextid
                                })),
                                itemsToGive: (offer.items_to_give || []).map(item => ({
                                    assetid: item.assetid,
                                    classid: item.classid,
                                    instanceid: item.instanceid,
                                    amount: item.amount || 1,
                                    market_hash_name: item.market_hash_name || item.name,
                                    name: item.name,
                                    icon_url: item.icon_url,
                                    appid: item.appid,
                                    contextid: item.contextid
                                })),
                                created: offer.time_created * 1000,
                                expiration: offer.expiration_time ? offer.expiration_time * 1000 : null
                            }));
                            
                            finish({ success: true, trades });
                            return;
                        }
                        
                        console.log('[get-incoming-trades] API returned no trades');
                    } catch (e) {
                        console.log('[get-incoming-trades] API parse error:', e.message);
                    }
                    
                    // Если API не сработал, пробуем получить HTML страницу
                    console.log('[get-incoming-trades] Trying HTML page...');
                    
                    const htmlUrl = `https://steamcommunity.com/profiles/${steamId64}/tradeoffers/received`;
                    
                    community.httpRequestGet(htmlUrl, (htmlErr, htmlRes, htmlBody) => {
                        if (htmlErr) {
                            console.error('[get-incoming-trades] HTML request error:', htmlErr.message);
                            finish({ success: false, error: htmlErr.message, trades: [] });
                            return;
                        }
                        
                        console.log('[get-incoming-trades] HTML response length:', htmlBody.length);
                        
                        // Проверяем не редирект ли на страницу входа
                        if (htmlBody.includes('login/home') || htmlBody.includes('Please sign in') || htmlBody.includes('auth_message_area')) {
                            console.log('[get-incoming-trades] Error: Page requires additional authentication');
                            finish({ 
                                success: false, 
                                error: 'Требуется дополнительная авторизация. Убедитесь что аккаунт не требует email подтверждения.', 
                                trades: [] 
                            });
                            return;
                        }
                        
                        // Парсим HTML для получения трейдов
                        try {
                            const trades = parseTradeOffers(htmlBody);
                            console.log('[get-incoming-trades] Parsed trades:', trades.length);
                            finish({ success: true, trades });
                        } catch (parseErr) {
                            console.error('[get-incoming-trades] Parse error:', parseErr.message);
                            finish({ success: false, error: parseErr.message, trades: [] });
                        }
                    });
                });
            });

            client.on('error', (err) => {
                console.error('[get-incoming-trades] Error:', err.message);
                if (!resolved) {
                    const errorMsg = err.message.toLowerCase();
                    if (errorMsg.includes('ratelimit') || errorMsg.includes('toomanyrequests') || errorMsg.includes('429')) {
                        finish({ success: false, error: 'Слишком много запросов к Steam. Подождите 2-5 минут и попробуйте снова.', trades: [] });
                    } else if (errorMsg.includes('throttle') || errorMsg.includes('logindeniedthrottle') || err.eresult === 84) {
                        finish({ success: false, error: 'Временная блокировка входа (Throttle). Подождите 5-30 минут перед следующей попыткой.', trades: [] });
                    } else {
                        finish({ success: false, error: err.message, trades: [] });
                    }
                }
            });

            console.log('[get-incoming-trades] Logging in...');
            const logOnOptions = {
                accountName: account.login,
                password: account.password
            };
            if (account.sharedSecret) {
                logOnOptions.twoFactorCode = SteamTotp.getAuthCode(Buffer.from(account.sharedSecret, 'base64'));
            }
            client.logOn(logOnOptions);
        });
    } catch (err) {
        console.error('Get incoming trades error:', err.message);
        return { success: false, error: err.message, trades: [] };
    }
});

// Парсинг HTML страницы с трейдами (новая структура Steam)
function parseTradeOffers(html) {
    const trades = [];
    
    console.log('[parseTradeOffers] Starting to parse HTML, length:', html.length);
    
    // Проверяем есть ли сообщение что трейдов нет
    if (html.includes('There are no items in your trade offers') || 
        html.includes('no_trade_offers') ||
        html.includes('empty_set')) {
        console.log('[parseTradeOffers] No trade offers message found');
        return [];
    }
    
    // Ищем все элементы трейдов по новой структуре Steam
    // <div class="tradeoffer" id="tradeofferid_XXXXX">
    const tradeOfferRegex = /<div[^>]*class="tradeoffer"[^>]*id="tradeofferid_(\d+)"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/g;
    const matches = [...html.matchAll(tradeOfferRegex)];
    
    console.log('[parseTradeOffers] Found tradeoffer regex matches:', matches.length);
    
    // Альтернативный поиск - просто ищем все div с id tradeofferid
    if (matches.length === 0) {
        const simpleRegex = /tradeofferid_(\d+)/g;
        const simpleMatches = [...html.matchAll(simpleRegex)];
        console.log('[parseTradeOffers] Simple search found:', simpleMatches.length);
        
        if (simpleMatches.length > 0) {
            // Нашли ID трейдов но не смогли распарсить структуру
            console.log('[parseTradeOffers] Trade offer IDs found:', simpleMatches.map(m => m[1]));
        }
    }
    
    for (const match of matches) {
        try {
            const id = match[1];
            const block = match[2];
            
            console.log('[parseTradeOffers] Processing tradeoffer:', id);
            
            // Извлекаем SteamID партнёра из data-partner атрибута
            const partnerMatch = block.match(/data-partner="(\d+)"/);
            const partnerSteamId64 = partnerMatch ? partnerMatch[1] : 'unknown';
            
            // Извлекаем состояние трейда
            let stateName = 'Active';
            let state = 1;
            
            if (block.includes('tradeoffer_status_pending')) {
                stateName = 'Pending';
                state = 6;
            } else if (block.includes('tradeoffer_status_active')) {
                stateName = 'Active';
                state = 1;
            } else if (block.includes('tradeoffer_status_accepted')) {
                stateName = 'Accepted';
                state = 2;
            } else if (block.includes('tradeoffer_status_in_escrow')) {
                stateName = 'In Escrow';
                state = 7;
            }
            
            // Извлекаем предметы которые мы получаем (received items)
            const itemsToReceive = [];
            const receivedItemsRegex = /<div[^>]*class="tradeoffer_items received"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/;
            const receivedMatch = block.match(receivedItemsRegex);
            
            if (receivedMatch) {
                const itemRegex = /<img[^>]*src="([^"]+)"[^>]*alt="([^"]+)"/g;
                let itemMatch;
                while ((itemMatch = itemRegex.exec(receivedMatch[1])) !== null) {
                    itemsToReceive.push({
                        name: itemMatch[2],
                        market_hash_name: itemMatch[2],
                        icon_url: itemMatch[1].replace('https://community.cloudflare.steamstatic.com/economy/image/', ''),
                        amount: 1
                    });
                }
            }
            
            // Извлекаем предметы которые мы отдаём (your items)
            const itemsToGive = [];
            const givenItemsRegex = /<div[^>]*class="tradeoffer_items primary"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/;
            const givenMatch = block.match(givenItemsRegex);
            
            if (givenMatch) {
                const itemRegex = /<img[^>]*src="([^"]+)"[^>]*alt="([^"]+)"/g;
                let itemMatch;
                while ((itemMatch = itemRegex.exec(givenMatch[1])) !== null) {
                    itemsToGive.push({
                        name: itemMatch[2],
                        market_hash_name: itemMatch[2],
                        icon_url: itemMatch[1].replace('https://community.cloudflare.steamstatic.com/economy/image/', ''),
                        amount: 1
                    });
                }
            }
            
            trades.push({
                id: id,
                partner: partnerSteamId64,
                partnerSteamId64: partnerSteamId64,
                state: state,
                stateName: stateName,
                itemsToReceive: itemsToReceive,
                itemsToGive: itemsToGive,
                created: Date.now(),
                expiration: null
            });
            
            console.log('[parseTradeOffers] Parsed trade:', { 
                id, 
                partnerSteamId64, 
                state: stateName,
                itemsToReceive: itemsToReceive.length, 
                itemsToGive: itemsToGive.length 
            });
        } catch (e) {
            console.error('[parseTradeOffers] Error parsing block:', e.message);
        }
    }
    
    console.log('[parseTradeOffers] Total trades parsed:', trades.length);
    return trades;
}

// Принятие трейда
ipcMain.handle('accept-trade', async (event, account, tradeId) => {
    try {
        console.log('\n=== accept-trade ===');
        console.log('Account:', account.login, 'Trade ID:', tradeId);

        const SteamUser = require('steam-user');
        const SteamCommunity = require('steamcommunity');
        const TradeOfferManager = require('steam-tradeoffer-manager');
        const SteamTotp = require('steam-totp');

        const client = new SteamUser();
        const community = new SteamCommunity();
        const manager = new TradeOfferManager({
            steam: client,
            community: community,
            language: 'en',
            pollInterval: 5000
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.logOff();
                resolve({ success: false, error: 'Таймаут (60 сек)' });
            }, 60000);

            let resolved = false;

            client.on('loggedOn', () => {
                console.log('[accept-trade] Logged in');
                client.setPersona(SteamUser.EPersonaState.Online);
            });

            client.on('steamGuard', (domain, callback) => {
                console.log('[accept-trade] Steam Guard');
                if (account.sharedSecret) {
                    const sharedSecret = Buffer.from(account.sharedSecret, 'base64');
                    const code = SteamTotp.getAuthCode(sharedSecret);
                    console.log('[accept-trade] 2FA code:', code);
                    callback(code);
                } else {
                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();
                    resolve({ success: false, error: 'Нужен sharedSecret' });
                }
            });

            client.on('webSession', (sessionID, cookies) => {
                console.log('[accept-trade] Web session');
                manager.setCookies(cookies, (err) => {
                    if (err) {
                        clearTimeout(timeout);
                        resolved = true;
                        client.logOff();
                        resolve({ success: false, error: err.message });
                        return;
                    }

                    // Получаем трейд по ID
                    manager.getOffer(tradeId, (err, offer) => {
                        if (err) {
                            clearTimeout(timeout);
                            resolved = true;
                            client.logOff();
                            resolve({ success: false, error: 'Трейд не найден: ' + err.message });
                            return;
                        }

                        console.log('[accept-trade] Found offer:', offer.id, 'state:', offer.state);

                        // При��������имаем трейд
                        offer.accept((err, status) => {
                            if (err) {
                                console.error('[accept-trade] Accept error:', err.message);
                                clearTimeout(timeout);
                                resolved = true;
                                client.logOff();
                                resolve({ success: false, error: err.message });
                                return;
                            }

                            console.log('[accept-trade] Offer accepted, status:', status);

                            // Если трейд требует подтверждения
                            if (status === 'pending') {
                                console.log('[accept-trade] Trade needs confirmation, offer ID:', offer.id);

                                // Ждём 2 секунды перед подтверждением
                                setTimeout(() => {
                                    console.log('[accept-trade] Attempting confirmation...');

                                    const tryConfirm = (attempt = 1) => {
                                        if (attempt > 3) {
                                            clearTimeout(timeout);
                                            resolved = true;
                                            client.logOff();
                                            resolve({ success: false, error: 'Не удалось подтвердить трейд после 3 попыток' });
                                            return;
                                        }

                                        console.log(`[accept-trade] Confirmation attempt ${attempt}/3...`);

                                        community.acceptConfirmationForObject(account.identitySecret, offer.id, (err) => {
                                            if (err) {
                                                console.error(`[accept-trade] Confirmation attempt ${attempt} failed:`, err.message);

                                                if (err.message.includes('No confirmation') || err.message.includes('not found')) {
                                                    setTimeout(() => tryConfirm(attempt + 1), 2000);
                                                } else {
                                                    clearTimeout(timeout);
                                                    resolved = true;
                                                    client.logOff();
                                                    resolve({ success: false, error: err.message + '. Подтвердите вручную!' });
                                                }
                                                return;
                                            }

                                            console.log('[accept-trade] ✓ Confirmation successful!');
                                            clearTimeout(timeout);
                                            resolved = true;
                                            client.logOff();
                                            resolve({ success: true, message: 'Трейд принят и подтверждён' });
                                        });
                                    };

                                    tryConfirm(1);
                                }, 2000);
                            } else {
                                clearTimeout(timeout);
                                resolved = true;
                                client.logOff();
                                resolve({ success: true, message: 'Трейд принят' });
                            }
                        });
                    });
                });
            });

            client.on('error', (err) => {
                console.error('[accept-trade] Error:', err.message);
                if (!resolved) {
                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();

                    // Обработка Rate Limit и Throttle
                    const errorMsg = err.message.toLowerCase();
                    if (errorMsg.includes('ratelimit') || errorMsg.includes('toomanyrequests') || errorMsg.includes('429')) {
                        resolve({ success: false, error: 'Слишком много запросов к Steam. Подождите 2-5 минут и попробуйте снова.' });
                    } else if (errorMsg.includes('throttle') || errorMsg.includes('logindeniedthrottle') || err.eresult === 84) {
                        resolve({ success: false, error: 'Временная блокировка входа (Throttle). Подождите 5-30 минут перед следующей попыткой.' });
                    } else {
                        resolve({ success: false, error: err.message });
                    }
                }
            });

            console.log('[accept-trade] Logging in...');
            const logOnOptions = {
                accountName: account.login,
                password: account.password
            };
            if (account.sharedSecret) {
                logOnOptions.twoFactorCode = SteamTotp.getAuthCode(Buffer.from(account.sharedSecret, 'base64'));
            }
            client.logOn(logOnOptions);
        });
    } catch (err) {
        console.error('Accept trade error:', err.message);
        return { success: false, error: err.message };
    }
});

// Отклонение трейда
ipcMain.handle('decline-trade', async (event, account, tradeId) => {
    try {
        console.log('\n=== decline-trade ===');
        console.log('Account:', account.login, 'Trade ID:', tradeId);

        const SteamUser = require('steam-user');
        const SteamCommunity = require('steamcommunity');
        const TradeOfferManager = require('steam-tradeoffer-manager');
        const SteamTotp = require('steam-totp');

        const client = new SteamUser();
        const community = new SteamCommunity();
        const manager = new TradeOfferManager({
            steam: client,
            community: community,
            language: 'en',
            pollInterval: 5000
        });

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                client.logOff();
                resolve({ success: false, error: 'Таймаут (60 сек)' });
            }, 60000);

            let resolved = false;

            client.on('loggedOn', () => {
                console.log('[decline-trade] Logged in');
                client.setPersona(SteamUser.EPersonaState.Online);
            });

            client.on('steamGuard', (domain, callback) => {
                console.log('[decline-trade] Steam Guard');
                if (account.sharedSecret) {
                    const sharedSecret = Buffer.from(account.sharedSecret, 'base64');
                    const code = SteamTotp.getAuthCode(sharedSecret);
                    console.log('[decline-trade] 2FA code:', code);
                    callback(code);
                } else {
                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();
                    resolve({ success: false, error: 'Нужен sharedSecret' });
                }
            });

            client.on('webSession', (sessionID, cookies) => {
                console.log('[decline-trade] Web session');
                manager.setCookies(cookies, (err) => {
                    if (err) {
                        clearTimeout(timeout);
                        resolved = true;
                        client.logOff();
                        resolve({ success: false, error: err.message });
                        return;
                    }

                    // Получаем трейд по ID
                    manager.getOffer(tradeId, (err, offer) => {
                        if (err) {
                            clearTimeout(timeout);
                            resolved = true;
                            client.logOff();
                            resolve({ success: false, error: 'Трейд не найден: ' + err.message });
                            return;
                        }

                        console.log('[decline-trade] Found offer:', offer.id);

                        // Отклоняем трейд
                        offer.decline((err) => {
                            clearTimeout(timeout);
                            resolved = true;
                            client.logOff();

                            if (err) {
                                console.error('[decline-trade] Decline error:', err.message);
                                resolve({ success: false, error: err.message });
                                return;
                            }

                            console.log('[decline-trade] ✓ Offer declined');
                            resolve({ success: true, message: 'Трейд отклонён' });
                        });
                    });
                });
            });

            client.on('error', (err) => {
                console.error('[decline-trade] Error:', err.message);
                if (!resolved) {
                    clearTimeout(timeout);
                    resolved = true;
                    client.logOff();

                    // Обработка Rate Limit и Throttle
                    const errorMsg = err.message.toLowerCase();
                    if (errorMsg.includes('ratelimit') || errorMsg.includes('toomanyrequests') || errorMsg.includes('429')) {
                        resolve({ success: false, error: 'Слишком много запросов к Steam. Подождите 2-5 минут и попробуйте снова.' });
                    } else if (errorMsg.includes('throttle') || errorMsg.includes('logindeniedthrottle') || err.eresult === 84) {
                        resolve({ success: false, error: 'Временная блокировка входа (Throttle). Подождите 5-30 минут перед следующей попыткой.' });
                    } else {
                        resolve({ success: false, error: err.message });
                    }
                }
            });

            console.log('[decline-trade] Logging in...');
            const logOnOptions = {
                accountName: account.login,
                password: account.password
            };
            if (account.sharedSecret) {
                logOnOptions.twoFactorCode = SteamTotp.getAuthCode(Buffer.from(account.sharedSecret, 'base64'));
            }
            client.logOn(logOnOptions);
        });
    } catch (err) {
        console.error('Decline trade error:', err.message);
        return { success: false, error: err.message };
    }
});

// Вспомогательная функция для названия состояния трейда
function getOfferStateName(state) {
    const states = {
        1: 'Active',           // Активный
        2: 'Accepted',         // Принят
        3: 'Countered',        // Отклонён
        4: 'Declined',         // Отменён
        5: 'Invalid',          // Недействителен
        6: 'CreatedNeedsConfirmation', // Создан (требует подтверждения)
        7: 'InEscrow',         // В эскроу
        8: 'CounteredByOtherParty', // Контрпредложение
        9: 'TimedOut',         // Истёк
        10: 'CanceledByOtherParty', // Отменён другой стороной
        11: 'Rollback',        // Откат
        12: 'AwaitingEmailConfirmation', // Ждёт подтверждения по email
        13: 'WaitingBothParties', // Ждут оба участника
        14: 'Expired',         // Истёк
        15: 'EscrowRollback'   // Откат эскроу
    };
    return states[state] || 'Unknown';
}
