//v.1
const SteamUser = require('steam-user');
const SteamCommunity = require('steamcommunity');
const SteamTotp = require('steam-totp');
const TradeOfferManager = require('steam-tradeoffer-manager');

const args = process.argv;

if (args.length < 7) {
    process.exit(0);
}

const login = args[2];
const password = args[3];
const shared_secret = args[4];
const identity_secret = args[5];
const tradeOfferLink = args[6];

let inventoryString = "730/2";

if (args[7]) {
    inventoryString = args[7];
}

function sendTrade() {
    const client = new SteamUser();
    const manager = new TradeOfferManager({
        "steam": client,
        "language": "en",
        "pollInterval": 5000
    });
    const community = new SteamCommunity();

    const logOnOptions = {
        "accountName": login,
        "password": password,
        "twoFactorCode": SteamTotp.getAuthCode(shared_secret)
    };

    client.logOn(logOnOptions);

    client.on('loggedOn', function() {
        console.log("Logged into Steam");
    });

    client.on('error', function(err) {
        errorHandler("Steam login error", err);
    });

    client.on('webSession', function(sessionID, cookies) {
        manager.setCookies(cookies, function(err) {
            errorHandler("Something went wrong while setting webSession", err);

            let offer = manager.createOffer(tradeOfferLink);
            let totalItemsCount = 0;
            let processedInventories = 0;
            let validInventories = 0;

            const inventories = inventoryString.split(',');

            if (inventories.length === 0) {
                console.log("No valid inventories provided");
                process.exit(-1);
            }

            inventories.forEach(inventoryPair => {
                const [appId, contextId] = inventoryPair.split('/');

                manager.getInventoryContents(
                    appId,
                    contextId,
                    true,
                    function(err, inventoryItems) {
                        processedInventories++;

                        if (err) {
                            console.log(`Inventory ${appId}:${contextId} is invalid or inaccessible: ${err.message}`);
                        } else {
                            const itemsCount = inventoryItems.length;
                            totalItemsCount += itemsCount;

                            inventoryItems.forEach(item => {
                                offer.addMyItem(item);
                            });

                            validInventories++;
                        }

                        if (processedInventories === inventories.length) {
                            if (validInventories === 0) {
                                console.log("No valid inventories found to send trade");
                                process.exit(-1);
                            }

                            console.log(`Total ${totalItemsCount} items to send from ${validInventories} valid inventories`);

                            offer.send(function(err, status) {
                                errorHandler("Something went wrong while sending trade offer", err);

                                if (status === 'pending') {
                                    console.log(`Offer #${offer.id} sent, but requires confirmation`);
                                    community.acceptConfirmationForObject(identity_secret, offer.id, function(err) {
                                        if (!err) {
                                            console.log("Offer confirmed");
                                            process.exit(1);
                                        }
                                        errorHandler("Something went wrong during trade confirmation", err);
                                    });
                                }
                            });
                        }
                    }
                );
            });
        });

        community.setCookies(cookies);
    });
}

function errorHandler(message, error) {
    if (error) {
        console.log(`HandleError ${message} ${error}`);
        process.exit(-1);
    }
}

sendTrade();
