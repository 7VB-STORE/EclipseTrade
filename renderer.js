// Состояние приложения
let accounts = [];
let selectedAccounts = new Set();
let currentInventory = [];
let selectedItems = new Map(); // Map<name, Set<assetid>> - выбранные assetid для каждого предмета
let currentSortOrder = 'price_desc';
let currentSearchQuery = '';

// Пагинация аккаунтов
let currentPage = 1;
const accountsPerPage = 8;

// Словарь валют
const currencySymbols = {
    '1': '$',    '2': '£',    '3': '€',    '4': 'CHF',  '5': '₽',
    '6': 'zł',   '7': 'R$',   '8': '¥',    '9': 'kr',   '10': 'Rp',
    '11': 'RM',  '12': '₱',   '13': 'S$',  '14': '฿',   '15': '₫',
    '16': '₩',   '17': '₺',   '18': '₴',   '19': '$',   '20': 'C$',
    '21': 'A$',  '22': 'NZ$', '23': '¥',   '24': '₹',   '25': '$',
    '26': 'S/',  '27': '$',   '28': 'R',   '29': 'HK$', '30': 'NT$',
    '31': '﷼',   '32': 'د.إ', '33': 'kr',  '34': '$'
};

// DOM элементы
const accountsList = document.getElementById('accountsList');
const tradeLinkInput = document.getElementById('tradeLinkInput');
const inventorySelect = document.getElementById('inventorySelect');
const inventoryContent = document.getElementById('inventoryContent');
const statusLog = document.getElementById('statusLog');
const sendTradeBtn = document.getElementById('sendTradeBtn');
const addAccountBtn = document.getElementById('addAccountBtn');
const loadInventoryBtn = document.getElementById('loadInventoryBtn');
const accountModal = document.getElementById('accountModal');
const accountForm = document.getElementById('accountForm');
const cancelModalBtn = document.getElementById('cancelModalBtn');
const selectAllBtn = document.getElementById('selectAllBtn');
const selectedCountEl = document.getElementById('selectedCount');
const currencySelect = document.getElementById('currencySelect');
const accountsSearchInput = document.getElementById('accountsSearchInput');
const inventorySearchInput = document.getElementById('inventorySearchInput');
const sortOrderSelect = document.getElementById('sortOrderSelect');
const get2FABtn = document.getElementById('get2FABtn');
const getTradeLinkBtn = document.getElementById('getTradeLinkBtn');
const tradeLinkModal = document.getElementById('tradeLinkModal');
const tradeLinkResult = document.getElementById('tradeLinkResult');
const copyTradeLinkBtn = document.getElementById('copyTradeLinkBtn');
const closeTradeLinkModalBtn = document.getElementById('closeTradeLinkModalBtn');
const faModal = document.getElementById('2FAModal');
const faCodeDisplay = document.getElementById('2FACodeDisplay');
const faTimer = document.getElementById('2FATimer');
const copyFaBtn = document.getElementById('copy2FABtn');
const refreshFaBtn = document.getElementById('refresh2FABtn');
const closeFaModalBtn = document.getElementById('close2FAModalBtn');
const viewTradesBtn = document.getElementById('viewTradesBtn');
const tradesModal = document.getElementById('tradesModal');
const tradesContent = document.getElementById('tradesContent');
const refreshTradesBtn = document.getElementById('refreshTradesBtn');
const closeTradesModalBtn = document.getElementById('closeTradesModalBtn');
const prevPageBtn = document.getElementById('prevPageBtn');
const nextPageBtn = document.getElementById('nextPageBtn');
const pageInfo = document.getElementById('pageInfo');

// Инициализация
async function init() {
    try {
        await loadAccounts();
        setupEventListeners();
        log('EclipseTradeBot запущен', 'info');
    } catch (err) {
        log(`Ошибка инициализации: ${err.message}`, 'error');
        console.error('Init error:', err);
    }
}

// Загрузка аккаунтов
async function loadAccounts() {
    try {
        accounts = await window.electronAPI.getAccounts();
        if (!Array.isArray(accounts)) {
            accounts = [];
            log('Ошибка загрузки аккаунтов: неверный формат данных', 'error');
        }
        selectedAccounts.clear();
        currentPage = 1; // Сбрасываем на первую страницу
        renderAccounts();
        updateSelectedCount();
        updatePagination(); // Обновляем пагинацию
    } catch (err) {
        log(`Ошибка загрузки аккаунтов: ${err.message}`, 'error');
        accounts = [];
    }
}

// Обновление счётчика выбранных
function updateSelectedCount() {
    if (selectedCountEl) {
        selectedCountEl.textContent = `Выбрано: ${selectedAccounts.size}`;
    }
    
    // Блокируем/разблокируем кнопку получения трейд-ссылки
    if (getTradeLinkBtn) {
        getTradeLinkBtn.disabled = selectedAccounts.size !== 1;
        getTradeLinkBtn.title = selectedAccounts.size === 1 ? 'Получить трейд-ссылку' : 'Выберите один аккаунт';
    }
}

// Получение трейд-ссылки
async function getTradeLink() {
    if (selectedAccounts.size !== 1) {
        log('Выберите один аккаунт для получения трейд-ссылки', 'error');
        return;
    }
    
    const index = Array.from(selectedAccounts)[0];
    const account = accounts[index];
    
    if (!account) {
        log('Аккаунт не найден', 'error');
        return;
    }
    
    log(`Получение трейд-ссылки для ${account.login}...`, 'info');
    
    try {
        const result = await window.electronAPI.getTradeLink(account);
        
        if (result.success && result.tradeLink) {
            tradeLinkResult.value = result.tradeLink;
            tradeLinkModal.classList.add('active');
            log(`Трейд-ссылка получена`, 'success');
        } else {
            log(`Ошибка: ${result.error}`, 'error');
        }
    } catch (err) {
        log(`Ошибка получения трейд-ссылки: ${err.message}`, 'error');
    }
}

// Рендеринг списка аккаунтов
function renderAccounts() {
    if (!accountsList) return;

    accountsList.innerHTML = '';

    if (accounts.length === 0) {
        accountsList.innerHTML = '<div class="inventory-placeholder">Нет аккаунтов</div>';
        updatePagination();
        return;
    }

    // Фильтрация по поиску
    const searchQuery = accountsSearchInput?.value?.toLowerCase().trim() || '';
    const filteredAccounts = accounts.filter((account, index) => {
        if (!searchQuery) return true;
        return account.login.toLowerCase().includes(searchQuery);
    });

    if (filteredAccounts.length === 0) {
        accountsList.innerHTML = '<div class="inventory-placeholder">Аккаунты не найдены</div>';
        updatePagination();
        return;
    }

    // Вычисляем страницу и количество страниц
    const totalPages = Math.ceil(filteredAccounts.length / accountsPerPage);
    
    // Проверяем что currentPage валидна
    if (currentPage > totalPages) {
        currentPage = totalPages;
    }
    if (currentPage < 1) {
        currentPage = 1;
    }

    // Получаем аккаунты для текущей страницы
    const startIndex = (currentPage - 1) * accountsPerPage;
    const endIndex = Math.min(startIndex + accountsPerPage, filteredAccounts.length);
    const pageAccounts = filteredAccounts.slice(startIndex, endIndex);

    // Рендерим аккаунты текущей страницы
    pageAccounts.forEach((account, index) => {
        // Находим оригинальный индекс в массиве accounts
        const originalIndex = accounts.findIndex(a => a.login === account.login);
        const item = document.createElement('div');
        item.className = 'account-item' + (selectedAccounts.has(originalIndex) ? ' selected' : '');

        const leftDiv = document.createElement('div');
        leftDiv.className = 'account-item-left';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'account-checkbox';
        checkbox.checked = selectedAccounts.has(originalIndex);
        checkbox.addEventListener('change', (e) => {
            e.stopPropagation();
            toggleAccountSelection(originalIndex);
        });

        const loginSpan = document.createElement('span');
        loginSpan.className = 'account-login';
        loginSpan.textContent = escapeHtml(account.login);
        loginSpan.addEventListener('click', () => toggleAccountSelection(originalIndex));

        leftDiv.appendChild(checkbox);
        leftDiv.appendChild(loginSpan);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'account-remove';
        removeBtn.textContent = '×';
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeAccount(originalIndex);
        });

        item.appendChild(leftDiv);
        item.appendChild(removeBtn);
        accountsList.appendChild(item);
    });

    updatePagination();
}

// Обновление пагинации
function updatePagination() {
    if (!pageInfo || !prevPageBtn || !nextPageBtn) return;

    const searchQuery = accountsSearchInput?.value?.toLowerCase().trim() || '';
    const filteredAccounts = accounts.filter((account, index) => {
        if (!searchQuery) return true;
        return account.login.toLowerCase().includes(searchQuery);
    });

    const totalPages = Math.ceil(filteredAccounts.length / accountsPerPage) || 1;
    
    pageInfo.textContent = `Стр. ${currentPage} / ${totalPages}`;
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;
}

// Переключение выбора аккаунта
function toggleAccountSelection(index) {
    if (selectedAccounts.has(index)) {
        selectedAccounts.delete(index);
    } else {
        selectedAccounts.add(index);
    }
    renderAccounts();
    updateSelectedCount();

    const count = selectedAccounts.size;
    if (count === 1) {
        log(`Выбран аккаунт: ${accounts[index]?.login || 'неизвестно'}`, 'info');
    } else if (count > 1) {
        log(`Выбрано аккаунтов: ${count}`, 'info');
    }
}

// Выбор всех аккаунтов
function selectAllAccounts() {
    if (selectedAccounts.size === accounts.length) {
        selectedAccounts.clear();
    } else {
        accounts.forEach((_, index) => selectedAccounts.add(index));
    }
    renderAccounts();
    updateSelectedCount();
}

// Удаление аккаунта
async function removeAccount(index) {
    if (!confirm(`Удалить аккаунт "${accounts[index]?.login}"?`)) {
        return;
    }

    selectedAccounts.delete(index);

    try {
        const result = await window.electronAPI.removeAccount(index);
        if (result.success) {
            accounts = result.accounts;

            const newSelected = new Set();
            selectedAccounts.forEach(idx => {
                if (idx < index) newSelected.add(idx);
                else if (idx > index) newSelected.add(idx - 1);
            });
            selectedAccounts = newSelected;

            // Проверяем нужно ли перейти на предыдущую страницу
            const searchQuery = accountsSearchInput?.value?.toLowerCase().trim() || '';
            const filteredAccounts = accounts.filter((account) => {
                if (!searchQuery) return true;
                return account.login.toLowerCase().includes(searchQuery);
            });
            const totalPages = Math.ceil(filteredAccounts.length / accountsPerPage);
            if (currentPage > totalPages && currentPage > 1) {
                currentPage = totalPages;
            }

            renderAccounts();
            updateSelectedCount();
            updatePagination();
            log('Аккаунт удалён', 'success');
        } else {
            log(`Ошибка удаления: ${result.error}`, 'error');
        }
    } catch (err) {
        log(`Ошибка удаления аккаунта: ${err.message}`, 'error');
    }
}

// Добавление аккаунта
async function addAccount(accountData) {
    try {
        const result = await window.electronAPI.addAccount(accountData);
        if (result.success) {
            accounts = result.accounts;
            renderAccounts();
            log(`Аккаунт ${accountData.login} добавлен`, 'success');
            return true;
        } else {
            log(`Ошибка: ${result.error}`, 'error');
            return false;
        }
    } catch (err) {
        log(`Ошибка добавления аккаунта: ${err.message}`, 'error');
        return false;
    }
}

// Загрузка инвентаря
async function loadInventory() {
    if (selectedAccounts.size === 0) {
        log('Выберите хотя бы один аккаунт', 'error');
        return;
    }

    const firstIndex = Array.from(selectedAccounts)[0];
    const account = accounts[firstIndex];
    
    if (!account) {
        log('Ошибка: аккаунт не найден', 'error');
        return;
    }
    
    const [appId, contextId] = inventorySelect.value.split('_');
    const currency = currencySelect.value;

    log(`Загрузка инвентаря ${getInventoryName(appId)}...`, 'info');
    loadInventoryBtn.disabled = true;
    loadInventoryBtn.textContent = 'Загрузка...';
    inventoryContent.innerHTML = '<div class="inventory-placeholder">Загрузка...</div>';

    try {
        const result = await window.electronAPI.getInventory(account, Number(appId), Number(contextId), currency);

        loadInventoryBtn.disabled = false;
        loadInventoryBtn.textContent = 'Загрузить';

        if (result.success) {
            currentInventory = result.items;
            renderInventory(result.items, getInventoryName(appId));
            log(`Загружено ${result.items.length} предметов (${account.login})`, 'success');
        } else {
            log(`Ошибка: ${result.error}`, 'error');
            currentInventory = [];
            inventoryContent.innerHTML = '<div class="inventory-placeholder">Ошибка загрузки</div>';
        }
    } catch (err) {
        loadInventoryBtn.disabled = false;
        loadInventoryBtn.textContent = 'Загрузить';
        log(`Ошибка загрузки: ${err.message}`, 'error');
        currentInventory = [];
        inventoryContent.innerHTML = '<div class="inventory-placeholder">Ошибка загрузки</div>';
    }
}

// Рендеринг инвентаря
function renderInventory(items, inventoryName) {
    if (!inventoryContent) return;

    if (items.length === 0) {
        inventoryContent.innerHTML = '<div class="inventory-placeholder">Инвентарь пуст</div>';
        return;
    }

    // Группируем предметы по названию
    const grouped = {};
    let totalPrice = 0;

    items.forEach(item => {
        const name = item.market_hash_name || item.name || `ID: ${item.id}`;
        if (!grouped[name]) {
            grouped[name] = {
                count: 0,
                items: [], // все копии предмета с разными assetid
                price: item.price
            };
        }
        grouped[name].count++;
        grouped[name].items.push(item);

        if (item.price && item.price.lowest_price) {
            const priceValue = parsePrice(item.price.lowest_price);
            if (priceValue) {
                totalPrice += priceValue;
            }
        }
    });

    let html = `
        <div class="inventory-header-wrapper">
            <div class="inventory-header">${escapeHtml(inventoryName)}</div>
            <div>
                <button class="btn btn-select-all-inventory" id="selectAllInventoryBtn">Выбрать все</button>
                <button class="btn btn-deselect-all-inventory" id="deselectAllInventoryBtn">Снять все</button>
            </div>
        </div>
        <div class="selected-items-info">
            <div class="selected-items-count" id="selectedItemsCount">Выбрано предметов: 0</div>
            <div class="selected-items-total" id="selectedItemsTotal" style="display: none;">Общая сумма: 0₽</div>
        </div>
    `;

    // Сортировка и поиск
    let sortedItems = Object.entries(grouped);
    
    // Поиск по названию
    const searchQuery = inventorySearchInput?.value?.toLowerCase().trim() || '';
    if (searchQuery) {
        sortedItems = sortedItems.filter(([name]) => 
            name.toLowerCase().includes(searchQuery)
        );
    }
    
    // Сортировка
    sortedItems.sort((a, b) => {
        const priceA = parsePrice(a[1].price?.lowest_price) || 0;
        const priceB = parsePrice(b[1].price?.lowest_price) || 0;
        const nameA = a[0].toLowerCase();
        const nameB = b[0].toLowerCase();
        
        switch (currentSortOrder) {
            case 'price_asc':
                return priceA - priceB;
            case 'price_desc':
                return priceB - priceA;
            case 'name_asc':
                return nameA.localeCompare(nameB, 'ru');
            case 'name_desc':
                return nameB.localeCompare(nameA, 'ru');
            default:
                return priceB - priceA;
        }
    });

    const currency = currencySelect?.value || '5';
    const symbol = currencySymbols[currency] || '₽';

    for (const [name, data] of sortedItems) {
        const priceHtml = data.price && data.price.lowest_price
            ? `<span class="inventory-item-price">${data.price.lowest_price}</span>`
            : '<span class="inventory-item-price no-price">Нет цены</span>';

        // Получаем уже выбранные assetid для этого предмета
        const selectedForName = selectedItems.get(name) || new Set();
        const selectedCount = selectedForName.size;
        const totalCount = data.count;

        html += `
            <div class="inventory-item-group">
                <div class="inventory-item-group-header">
                    <span class="inventory-item-name">${escapeHtml(name)}</span>
                    <div class="inventory-item-right">
                        ${priceHtml}
                        <span class="inventory-item-count">x${totalCount}</span>
                    </div>
                </div>
                <div class="inventory-item-quantity-selector">
                    <label>
                        <input type="checkbox" class="inventory-group-checkbox" data-item-name="${escapeHtml(name)}" ${selectedCount > 0 ? 'checked' : ''}>
                        Выбрать:
                        <input type="number" class="inventory-quantity-input"
                               data-item-name="${escapeHtml(name)}"
                               min="0" max="${totalCount}" value="${selectedCount}">
                        из ${totalCount}
                    </label>
                </div>
            </div>
        `;
    }

    html += `
        <div class="inventory-total">
            <div>Всего предметов: ${items.length}</div>
            <div class="inventory-total-price">Общая цена: ${symbol}${totalPrice.toFixed(2)}</div>
        </div>
    `;

    inventoryContent.innerHTML = html;

    // Инициализируем обработчики
    initInventoryEventListeners(items);
}

// Инициализация обработчиков для инвентаря
function initInventoryEventListeners(items) {
    // Обработчики для чекбоксов групп
    document.querySelectorAll('.inventory-group-checkbox').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
            const name = e.target.dataset.itemName;
            const groupElement = e.target.closest('.inventory-item-group');
            const quantityInput = groupElement.querySelector('.inventory-quantity-input');
            
            if (e.target.checked) {
                // Выбрать все предметы этой группы
                selectAllItemsInGroup(name, items);
                quantityInput.value = selectedItems.get(name)?.size || 0;
            } else {
                // Снять все предметы этой группы
                deselectAllItemsInGroup(name);
                quantityInput.value = 0;
            }
            updateSelectedItemsCount();
        });
    });

    // Обработчики для input количества
    document.querySelectorAll('.inventory-quantity-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const name = e.target.dataset.itemName;
            const quantity = parseInt(e.target.value) || 0;
            const maxQuantity = parseInt(e.target.max) || 0;
            
            // Обновляем выбор предметов
            selectQuantityItems(name, items, Math.min(quantity, maxQuantity));
            updateSelectedItemsCount();
            
            // Синхронизируем чекбокс
            const checkbox = document.querySelector(`.inventory-group-checkbox[data-item-name="${CSS.escape(name)}"]`);
            if (checkbox) {
                checkbox.checked = quantity > 0;
            }
        });
    });

    // Кнопка "Выбрать все"
    const selectAllBtn = document.getElementById('selectAllInventoryBtn');
    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', () => {
            selectAllInventoryItems(items);
        });
    }

    // Кнопка "Снять все"
    const deselectAllBtn = document.getElementById('deselectAllInventoryBtn');
    if (deselectAllBtn) {
        deselectAllBtn.addEventListener('click', () => {
            deselectAllInventoryItems();
        });
    }
}

// Выбрать все предметы в группе
function selectAllItemsInGroup(name, allItems) {
    const itemsForName = allItems.filter(item => {
        const itemName = item.market_hash_name || item.name || `ID: ${item.id}`;
        return itemName === name && item.assetid;
    });
    
    const selectedSet = new Set();
    itemsForName.forEach(item => selectedSet.add(item.assetid));
    selectedItems.set(name, selectedSet);
}

// Снять все предметы в группе
function deselectAllItemsInGroup(name) {
    selectedItems.delete(name);
}

// Выбрать конкретное количество предметов
function selectQuantityItems(name, allItems, quantity) {
    const itemsForName = allItems.filter(item => {
        const itemName = item.market_hash_name || item.name || `ID: ${item.id}`;
        return itemName === name && item.assetid;
    });
    
    // Получаем текущие выбранные
    const currentSelected = selectedItems.get(name) || new Set();
    
    // Если нужно выбрать 0 - очищаем
    if (quantity === 0) {
        selectedItems.delete(name);
        return;
    }
    
    // Если нужно выбрать больше чем есть - выбираем все
    if (quantity >= itemsForName.length) {
        const allSelected = new Set();
        itemsForName.forEach(item => allSelected.add(item.assetid));
        selectedItems.set(name, allSelected);
        return;
    }
    
    // Выбираем первые N предметов (можно улучшить логику выбора)
    const newSelected = new Set();
    let added = 0;
    
    // Сначала добавляем уже выбранные (если они ещё есть)
    for (const assetid of currentSelected) {
        if (itemsForName.find(item => item.assetid === assetid)) {
            newSelected.add(assetid);
            added++;
        }
    }
    
    // Добавляем остальные пока не наберём нужное количество
    for (const item of itemsForName) {
        if (added >= quantity) break;
        if (!newSelected.has(item.assetid)) {
            newSelected.add(item.assetid);
            added++;
        }
    }
    
    selectedItems.set(name, newSelected);
}

// Выбрать все предметы
function selectAllInventoryItems(allItems) {
    allItems.forEach(item => {
        if (item.assetid) {
            const name = item.market_hash_name || item.name || `ID: ${item.id}`;
            if (!selectedItems.has(name)) {
                selectedItems.set(name, new Set());
            }
            selectedItems.get(name).add(item.assetid);
        }
    });
    
    // Обновляем UI
    document.querySelectorAll('.inventory-group-checkbox').forEach(cb => {
        cb.checked = true;
    });
    document.querySelectorAll('.inventory-quantity-input').forEach(input => {
        input.value = input.max;
    });
    
    updateSelectedItemsCount();
}

// Снять все предметы
function deselectAllInventoryItems() {
    selectedItems.clear();
    
    // Обновляем UI
    document.querySelectorAll('.inventory-group-checkbox').forEach(cb => {
        cb.checked = false;
    });
    document.querySelectorAll('.inventory-quantity-input').forEach(input => {
        input.value = 0;
    });
    
    updateSelectedItemsCount();
}

// Обновление счётчика выбранных предметов
function updateSelectedItemsCount() {
    const countEl = document.getElementById('selectedItemsCount');
    const totalEl = document.getElementById('selectedItemsTotal');
    
    if (countEl) {
        let totalSelected = 0;
        let totalPrice = 0;
        const symbol = currencySymbols[currencySelect?.value || '5'] || '₽';
        
        selectedItems.forEach((assetIds, name) => {
            totalSelected += assetIds.size;
            
            // Находим предметы в инвентаре для подсчёта цены
            const matchingItems = currentInventory.filter(item => {
                const itemName = item.market_hash_name || item.name || `ID: ${item.id}`;
                return itemName === name && assetIds.has(item.assetid);
            });
            
            matchingItems.forEach(item => {
                if (item.price && item.price.lowest_price) {
                    const priceValue = parsePrice(item.price.lowest_price);
                    if (priceValue) {
                        totalPrice += priceValue;
                    }
                }
            });
        });
        
        countEl.textContent = `Выбрано предметов: ${totalSelected}`;
        
        if (totalEl) {
            totalEl.textContent = `Общая сумма: ${symbol}${totalPrice.toFixed(2)}`;
            totalEl.style.display = totalSelected > 0 ? 'block' : 'none';
        }
    }
}

// Парсинг цены
function parsePrice(priceStr) {
    if (!priceStr) return null;
    const cleaned = priceStr.replace(/[^0-9.,]/g, '').replace(',', '.');
    const price = parseFloat(cleaned);
    return isNaN(price) ? null : price;
}

// Отправка трейда
async function sendTrade() {
    if (selectedAccounts.size === 0) {
        log('Выберите хотя бы один аккаунт', 'error');
        return;
    }

    const tradeLink = tradeLinkInput.value.trim();
    if (!tradeLink) {
        log('Введите ссылку на трейд', 'error');
        return;
    }

    // Валидация ссылки
    if (!tradeLink.includes('steamcommunity.com') || !tradeLink.includes('tradeoffer')) {
        log('Неверная ссылка на трейд', 'error');
        return;
    }

    // Проверка identitySecret
    const accountsWithoutSecret = [];
    for (const index of selectedAccounts) {
        const account = accounts[index];
        if (!account.identitySecret || account.identitySecret.trim() === '') {
            accountsWithoutSecret.push(account.login);
        }
    }

    if (accountsWithoutSecret.length > 0) {
        log(`Ошибка: Нет Identity Secret: ${accountsWithoutSecret.join(', ')}`, 'error');
        log('Добавьте Identity Secret в настройках аккаунта', 'error');
        return;
    }

    const [appId, contextId] = inventorySelect.value.split('_');

    // Собираем все выбранные assetid
    const allSelectedAssetIds = [];
    selectedItems.forEach((assetIds) => {
        assetIds.forEach(id => allSelectedAssetIds.push(id));
    });

    // Проверяем, выбраны ли предметы
    const hasSelectedItems = allSelectedAssetIds.length > 0;
    if (hasSelectedItems) {
        log(`Отправка трейда с ${allSelectedAssetIds.length} выбранными предмет(ов)...`, 'info');
    } else {
        log(`Отправка трейда со всеми предметами из инвентаря...`, 'info');
    }

    sendTradeBtn.disabled = true;
    sendTradeBtn.textContent = 'Отправка...';

    let successCount = 0;
    let failCount = 0;

    for (const index of selectedAccounts) {
        const account = accounts[index];

        if (!account) continue;

        try {
            // Передаём выбранные предметы если они есть
            const itemsToSend = hasSelectedItems ? allSelectedAssetIds : null;
            
            const result = await window.electronAPI.sendTrade(
                account,
                tradeLink,
                Number(appId),
                Number(contextId),
                account.identitySecret,
                itemsToSend
            );

            if (result.success) {
                const itemsCount = result.itemsCount || 0;
                log(`✓ ${account.login}: Трейд #${result.offerId} отправлен (${itemsCount} предм.)`, 'success');
                successCount++;
            } else {
                log(`✗ ${account.login}: ${result.error}`, 'error');
                failCount++;
            }
        } catch (err) {
            log(`✗ ${account.login}: ${err.message}`, 'error');
            failCount++;
        }

        // Увеличенная задержка для избежания Rate Limit (5 секунд между аккаунтами)
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    sendTradeBtn.disabled = false;
    sendTradeBtn.textContent = '📤 Отправить трейд';

    log(`Готово! Успешно: ${successCount}, Ошибок: ${failCount}`, 'info');
}

// Логирование
function log(message, type = 'info') {
    if (!statusLog) return;
    
    const time = new Date().toLocaleTimeString('ru-RU');
    const entry = document.createElement('div');
    entry.className = `status-entry ${type}`;
    entry.textContent = `[${time}] ${message}`;
    statusLog.appendChild(entry);
    statusLog.scrollTop = statusLog.scrollHeight;
}

// Вспомогательные функции
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function getInventoryName(appId) {
    const names = { '730': 'CS:GO', '440': 'Team Fortress 2', '753': 'Steam' };
    return names[appId] || appId;
}

// Обработчики событий
function setupEventListeners() {
    if (addAccountBtn) {
        addAccountBtn.addEventListener('click', () => {
            accountModal.classList.add('active');
        });
    }

    if (cancelModalBtn) {
        cancelModalBtn.addEventListener('click', () => {
            accountModal.classList.remove('active');
            accountForm.reset();
        });
    }

    if (accountForm) {
        accountForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const accountData = {
                login: document.getElementById('accLogin').value.trim(),
                password: document.getElementById('accPassword').value,
                sharedSecret: document.getElementById('accSharedSecret').value.trim(),
                identitySecret: document.getElementById('accIdentitySecret').value.trim()
            };
            
            // Валидация на стороне клиента
            if (!accountData.login) {
                log('Введите логин', 'error');
                return;
            }
            if (!accountData.password) {
                log('Введите пароль', 'error');
                return;
            }
            if (!accountData.sharedSecret) {
                log('Введите Shared Secret', 'error');
                return;
            }
            if (!accountData.identitySecret) {
                log('Введите Identity Secret', 'error');
                return;
            }

            const success = await addAccount(accountData);
            if (success) {
                accountModal.classList.remove('active');
                accountForm.reset();
            }
        });
    }

    if (selectAllBtn) {
        selectAllBtn.addEventListener('click', selectAllAccounts);
    }

    // Получение трейд-ссылки
    if (getTradeLinkBtn) {
        getTradeLinkBtn.addEventListener('click', getTradeLink);
    }

    // Копирование трейд-ссылки
    if (copyTradeLinkBtn) {
        copyTradeLinkBtn.addEventListener('click', () => {
            const tradeLink = tradeLinkResult.value;
            if (tradeLink) {
                navigator.clipboard.writeText(tradeLink).then(() => {
                    log('Трейд-ссылка скопирована в буфер обмена', 'success');
                    const originalText = copyTradeLinkBtn.innerHTML;
                    copyTradeLinkBtn.innerHTML = '<span class="btn-icon">✓</span> Скопировано!';
                    setTimeout(() => {
                        copyTradeLinkBtn.innerHTML = originalText;
                    }, 2000);
                }).catch(err => {
                    log(`Ошибка копирования: ${err.message}`, 'error');
                });
            }
        });
    }

    // Закрытие модального окна трейд-ссылки
    if (closeTradeLinkModalBtn) {
        closeTradeLinkModalBtn.addEventListener('click', () => {
            tradeLinkModal.classList.remove('active');
        });
    }

    if (tradeLinkModal) {
        tradeLinkModal.addEventListener('click', (e) => {
            if (e.target === tradeLinkModal) {
                tradeLinkModal.classList.remove('active');
            }
        });
    }

    // Импорт из acc.txt
    const importAccBtn = document.getElementById('importAccBtn');
    if (importAccBtn) {
        importAccBtn.addEventListener('click', async () => {
            try {
                const filePath = await window.electronAPI.selectFile('txt');
                if (filePath) {
                    const result = await window.electronAPI.importAccTxt(filePath);
                    if (result.success) {
                        accounts = result.accounts;
                        selectedAccounts.clear(); // Очищаем выбранные аккаунты
                        renderAccounts();
                        updateSelectedCount();
                        let msg = `acc.txt: добавлено ${result.added}`;
                        if (result.updated > 0) msg += `, обновлено ${result.updated}`;
                        if (result.errors > 0) msg += `, ошибок ${result.errors}`;
                        log(msg, 'success');
                    } else {
                        log(`Ошибка импорта: ${result.error}`, 'error');
                    }
                }
            } catch (err) {
                log(`Ошибка импорта: ${err.message}`, 'error');
            }
        });
    }

    // Импорт из maFiles
    const importMaFilesBtn = document.getElementById('importMaFilesBtn');
    if (importMaFilesBtn) {
        importMaFilesBtn.addEventListener('click', async () => {
            try {
                const folderPath = await window.electronAPI.selectFile('maFiles');
                if (folderPath) {
                    const result = await window.electronAPI.importMaFiles(folderPath);
                    if (result.success) {
                        accounts = result.accounts;
                        selectedAccounts.clear(); // Очищаем выбранные аккаунты
                        renderAccounts();
                        updateSelectedCount();
                        let msg = `maFiles: добавлено ${result.added}`;
                        if (result.updated > 0) msg += `, обновлено ${result.updated}`;
                        if (result.fileErrors > 0) msg += `, ошибок ${result.fileErrors}`;
                        log(msg, 'success');
                    } else {
                        log(`Ошибка импорта: ${result.error}`, 'error');
                    }
                }
            } catch (err) {
                log(`Ошибка импорта: ${err.message}`, 'error');
            }
        });
    }

    if (loadInventoryBtn) {
        loadInventoryBtn.addEventListener('click', loadInventory);
    }
    
    if (sendTradeBtn) {
        sendTradeBtn.addEventListener('click', sendTrade);
    }

    // Обработчик смены валюты
    if (currencySelect) {
        currencySelect.addEventListener('change', () => {
            if (currentInventory.length > 0) {
                const [appId] = inventorySelect.value.split('_');
                renderInventory(currentInventory, getInventoryName(appId));
            }
        });
    }

    // Поиск по аккаунтам
    if (accountsSearchInput) {
        accountsSearchInput.addEventListener('input', () => {
            currentPage = 1; // Сбрасываем на первую страницу при поиске
            renderAccounts();
        });
    }

    // Пагинация - предыдущая страница
    if (prevPageBtn) {
        prevPageBtn.addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                renderAccounts();
            }
        });
    }

    // Пагинация - следующая страница
    if (nextPageBtn) {
        nextPageBtn.addEventListener('click', () => {
            const searchQuery = accountsSearchInput?.value?.toLowerCase().trim() || '';
            const filteredAccounts = accounts.filter((account) => {
                if (!searchQuery) return true;
                return account.login.toLowerCase().includes(searchQuery);
            });
            const totalPages = Math.ceil(filteredAccounts.length / accountsPerPage);
            
            if (currentPage < totalPages) {
                currentPage++;
                renderAccounts();
            }
        });
    }

    // Поиск по инвентарю
    if (inventorySearchInput) {
        inventorySearchInput.addEventListener('input', () => {
            if (currentInventory.length > 0) {
                const [appId] = inventorySelect.value.split('_');
                renderInventory(currentInventory, getInventoryName(appId));
            }
        });
    }

    // Сортировка инвентаря
    if (sortOrderSelect) {
        sortOrderSelect.addEventListener('change', (e) => {
            currentSortOrder = e.target.value;
            if (currentInventory.length > 0) {
                const [appId] = inventorySelect.value.split('_');
                renderInventory(currentInventory, getInventoryName(appId));
            }
        });
    }

    // Получение 2FA кода
    let faInterval = null;
    if (get2FABtn) {
        get2FABtn.addEventListener('click', () => {
            if (selectedAccounts.size !== 1) {
                log('Выберите один аккаунт для получения 2FA кода', 'error');
                return;
            }

            const index = Array.from(selectedAccounts)[0];
            const account = accounts[index];

            if (!account || !account.sharedSecret) {
                log('У аккаунта нет Shared Secret', 'error');
                return;
            }

            log(`Генерация 2FA кода для ${account.login}...`, 'info');

            // Генерация кода
            const generate2FA = async () => {
                try {
                    const result = await window.electronAPI.generate2FACode(account.sharedSecret);
                    if (result.success) {
                        if (faCodeDisplay) faCodeDisplay.textContent = result.code;
                        if (faTimer) faTimer.textContent = result.timeLeft;
                    } else {
                        log(`Ошибка 2FA: ${result.error}`, 'error');
                        if (faInterval) clearInterval(faInterval);
                    }
                } catch (err) {
                    log(`Ошибка генерации 2FA: ${err.message}`, 'error');
                    if (faInterval) clearInterval(faInterval);
                }
            };

            // Первая генерация
            generate2FA();

            // Обновление каждые 30 секунд
            if (faInterval) clearInterval(faInterval);
            faInterval = setInterval(generate2FA, 1000);

            // Показ модального окна
            faModal.classList.add('active');

            // Обработчик копирования
            if (copyFaBtn) {
                copyFaBtn.onclick = () => {
                    const code = faCodeDisplay?.textContent || '';
                    if (code && code !== '------') {
                        navigator.clipboard.writeText(code).then(() => {
                            log('2FA код скопирован', 'success');
                        });
                    }
                };
            }

            // Обработчик обновления
            if (refreshFaBtn) {
                refreshFaBtn.onclick = () => {
                    generate2FA();
                };
            }

            // Обработчик закрытия
            const closeFaHandler = () => {
                if (faInterval) clearInterval(faInterval);
                faInterval = null;
                faModal.classList.remove('active');
            };

            if (closeFaModalBtn) {
                closeFaModalBtn.onclick = closeFaHandler;
            }

            faModal.onclick = (e) => {
                if (e.target === faModal) {
                    closeFaHandler();
                }
            };
        });
    }

    // Закрытие модального окна
    if (accountModal) {
        accountModal.addEventListener('click', (e) => {
            if (e.target === accountModal) {
                accountModal.classList.remove('active');
            }
        });
    }

    // Закрытие по Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (accountModal?.classList.contains('active')) {
                accountModal.classList.remove('active');
            }
            if (faModal?.classList.contains('active')) {
                if (faInterval) clearInterval(faInterval);
                faInterval = null;
                faModal.classList.remove('active');
            }
            if (tradeLinkModal?.classList.contains('active')) {
                tradeLinkModal.classList.remove('active');
            }
            if (tradesModal?.classList.contains('active')) {
                tradesModal.classList.remove('active');
            }
        }
    });

    // Просмотр входящих трейдов
    if (viewTradesBtn) {
        viewTradesBtn.addEventListener('click', () => {
            if (selectedAccounts.size !== 1) {
                log('Выберите один аккаунт для просмотра трейдов', 'error');
                return;
            }
            tradesModal.classList.add('active');
        });
    }

    // Обновление трейдов
    if (refreshTradesBtn) {
        refreshTradesBtn.addEventListener('click', loadIncomingTrades);
    }

    // Закрытие модального окна трейдов
    if (closeTradesModalBtn) {
        closeTradesModalBtn.addEventListener('click', () => {
            tradesModal.classList.remove('active');
        });
    }

    if (tradesModal) {
        tradesModal.addEventListener('click', (e) => {
            if (e.target === tradesModal) {
                tradesModal.classList.remove('active');
            }
        });
    }
}

// Загрузка входящих трейдов
async function loadIncomingTrades() {
    if (selectedAccounts.size !== 1) {
        log('Выберите один аккаунт для просмотра трейдов', 'error');
        return;
    }

    const index = Array.from(selectedAccounts)[0];
    const account = accounts[index];

    if (!account) {
        log('Аккаунт не найден', 'error');
        return;
    }

    log(`Загрузка входящих трейдов для ${account.login}...`, 'info');
    refreshTradesBtn.disabled = true;
    refreshTradesBtn.textContent = 'Загрузка...';
    tradesContent.innerHTML = '<div class="inventory-placeholder">Загрузка...</div>';

    try {
        const result = await window.electronAPI.getIncomingTrades(account);

        refreshTradesBtn.disabled = false;
        refreshTradesBtn.textContent = '🔄 Обновить';

        if (result.success) {
            renderIncomingTrades(result.trades, account);
            log(`Загружено ${result.trades.length} входящих трейд(ов)`, 'success');
        } else {
            // Обработка Rate Limit и Throttle
            const errorMsg = result.error.toLowerCase();
            if (errorMsg.includes('ratelimit') || errorMsg.includes('toomanyrequests') || errorMsg.includes('429')) {
                log(`⚠️ ${result.error}`, 'error');
                tradesContent.innerHTML = '<div class="inventory-placeholder" style="color: #ffc107;">Steam ограничил запросы. Подождите 2-5 минут...</div>';
            } else if (errorMsg.includes('throttle') || errorMsg.includes('logindeniedthrottle')) {
                log(`⚠️ ${result.error}`, 'error');
                tradesContent.innerHTML = '<div class="inventory-placeholder" style="color: #ff9800;">Временная блокировка Steam. Подождите 5-30 минут...</div>';
            } else {
                log(`Ошибка: ${result.error}`, 'error');
                tradesContent.innerHTML = '<div class="inventory-placeholder">Ошибка загрузки</div>';
            }
        }
    } catch (err) {
        refreshTradesBtn.disabled = false;
        refreshTradesBtn.textContent = '🔄 Обновить';
        log(`Ошибка загрузки: ${err.message}`, 'error');
        tradesContent.innerHTML = '<div class="inventory-placeholder">Ошибка загрузки</div>';
    }
}

// Рендеринг входящих трейдов
function renderIncomingTrades(trades, account) {
    if (!tradesContent) return;

    if (trades.length === 0) {
        tradesContent.innerHTML = '<div class="inventory-placeholder">Входящих трейдов нет</div>';
        return;
    }

    let html = '';

    trades.forEach(trade => {
        const stateClass = getTradeStateClass(trade.state);
        const itemsToReceive = trade.itemsToReceive;
        const itemsToGive = trade.itemsToGive;

        html += `
            <div class="trade-item">
                <div class="trade-item-header">
                    <div class="trade-item-info">
                        <span class="trade-item-id">Трейд #${trade.id}</span>
                        <span class="trade-item-state ${stateClass}">${trade.stateName}</span>
                        <span class="trade-item-partner">От: ${trade.partnerSteamId64}</span>
                    </div>
                    <div class="trade-item-actions">
                        ${trade.state === 1 ? `
                            <button class="btn btn-accept" onclick="acceptTradeHandler('${trade.id}')">
                                <span class="btn-icon">✓</span> Принять
                            </button>
                            <button class="btn btn-decline" onclick="declineTradeHandler('${trade.id}')">
                                <span class="btn-icon">✗</span> Отклонить
                            </button>
                        ` : ''}
                    </div>
                </div>
                <div class="trade-item-body">
                    ${itemsToGive.length > 0 ? `
                        <div class="trade-section">
                            <div class="trade-section-title">Вы отдаёте:</div>
                            <div class="trade-items-list">
                                ${itemsToGive.map(item => `
                                    <div class="trade-item-card">
                                        <img src="https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}/64fx36f/" alt="${escapeHtml(item.name)}" class="trade-item-icon">
                                        <div class="trade-item-details">
                                            <div class="trade-item-name">${escapeHtml(item.market_hash_name || item.name)}</div>
                                            <div class="trade-item-qty">x${item.amount || 1}</div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                    ${itemsToReceive.length > 0 ? `
                        <div class="trade-section">
                            <div class="trade-section-title">Вы получаете:</div>
                            <div class="trade-items-list">
                                ${itemsToReceive.map(item => `
                                    <div class="trade-item-card">
                                        <img src="https://community.cloudflare.steamstatic.com/economy/image/${item.icon_url}/64fx36f/" alt="${escapeHtml(item.name)}" class="trade-item-icon">
                                        <div class="trade-item-details">
                                            <div class="trade-item-name">${escapeHtml(item.market_hash_name || item.name)}</div>
                                            <div class="trade-item-qty">x${item.amount || 1}</div>
                                        </div>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    });

    tradesContent.innerHTML = html;
}

// Обработчик принятия трейда
async function acceptTradeHandler(tradeId) {
    if (selectedAccounts.size !== 1) {
        log('Выберите один аккаунт', 'error');
        return;
    }

    const index = Array.from(selectedAccounts)[0];
    const account = accounts[index];

    if (!account) {
        log('Аккаунт не найден', 'error');
        return;
    }

    log(`Принятие трейда #${tradeId}...`, 'info');

    try {
        const result = await window.electronAPI.acceptTrade(account, tradeId);

        if (result.success) {
            log(`✓ ${result.message}`, 'success');
            // Обновляем список трейдов с задержкой
            setTimeout(() => loadIncomingTrades(), 1000);
        } else {
            // Обработка Rate Limit и Throttle
            const errorMsg = result.error.toLowerCase();
            if (errorMsg.includes('ratelimit') || errorMsg.includes('toomanyrequests') || errorMsg.includes('429')) {
                log(`⚠️ ${result.error}`, 'error');
            } else if (errorMsg.includes('throttle') || errorMsg.includes('logindeniedthrottle')) {
                log(`⚠️ ${result.error}`, 'error');
            } else {
                log(`Ошибка: ${result.error}`, 'error');
            }
        }
    } catch (err) {
        log(`Ошибка: ${err.message}`, 'error');
    }
}

// Обработчик отклонения трейда
async function declineTradeHandler(tradeId) {
    if (selectedAccounts.size !== 1) {
        log('Выберите один аккаунт', 'error');
        return;
    }

    const index = Array.from(selectedAccounts)[0];
    const account = accounts[index];

    if (!account) {
        log('Аккаунт не найден', 'error');
        return;
    }

    log(`Отклонение трейда #${tradeId}...`, 'info');

    try {
        const result = await window.electronAPI.declineTrade(account, tradeId);

        if (result.success) {
            log(`✓ ${result.message}`, 'success');
            // Обновляем список трейдов с задержкой
            setTimeout(() => loadIncomingTrades(), 1000);
        } else {
            // Обработка Rate Limit и Throttle
            const errorMsg = result.error.toLowerCase();
            if (errorMsg.includes('ratelimit') || errorMsg.includes('toomanyrequests') || errorMsg.includes('429')) {
                log(`⚠️ ${result.error}`, 'error');
            } else if (errorMsg.includes('throttle') || errorMsg.includes('logindeniedthrottle')) {
                log(`⚠️ ${result.error}`, 'error');
            } else {
                log(`Ошибка: ${result.error}`, 'error');
            }
        }
    } catch (err) {
        log(`Ошибка: ${err.message}`, 'error');
    }
}

// Вспомогательная функция для класса состояния трейда
function getTradeStateClass(state) {
    const classes = {
        1: 'trade-state-active',
        2: 'trade-state-accepted',
        3: 'trade-state-countered',
        4: 'trade-state-declined',
        5: 'trade-state-invalid',
        6: 'trade-state-pending',
        7: 'trade-state-escrow',
        8: 'trade-state-countered',
        9: 'trade-state-expired',
        10: 'trade-state-cancelled',
        14: 'trade-state-expired'
    };
    return classes[state] || 'trade-state-unknown';
}

// Делаем функции доступными глобально для HTML onclick
window.acceptTradeHandler = acceptTradeHandler;
window.declineTradeHandler = declineTradeHandler;

// Запуск
init();
