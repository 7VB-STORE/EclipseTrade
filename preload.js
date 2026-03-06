const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getAccounts: () => ipcRenderer.invoke('get-accounts'),
    addAccount: (account) => ipcRenderer.invoke('add-account', account),
    removeAccount: (index) => ipcRenderer.invoke('remove-account', index),
    getInventory: (account, appId, contextId, currency) => ipcRenderer.invoke('get-inventory', account, appId, contextId, currency),
    sendTrade: (account, tradeLink, appId, contextId, identitySecret, itemsToSend = null) =>
        ipcRenderer.invoke('send-trade', account, tradeLink, appId, contextId, identitySecret, itemsToSend),
    getTradeLink: (account) => ipcRenderer.invoke('get-trade-link', account),
    selectFile: (fileType) => ipcRenderer.invoke('select-file', fileType),
    importAccTxt: (filePath) => ipcRenderer.invoke('import-acc-txt', filePath),
    importMaFiles: (filePath) => ipcRenderer.invoke('import-mafiles', filePath),
    generate2FACode: (sharedSecret) => ipcRenderer.invoke('generate-2fa-code', sharedSecret),
    getIncomingTrades: (account) => ipcRenderer.invoke('get-incoming-trades', account),
    acceptTrade: (account, tradeId) => ipcRenderer.invoke('accept-trade', account, tradeId),
    declineTrade: (account, tradeId) => ipcRenderer.invoke('decline-trade', account, tradeId)
});
