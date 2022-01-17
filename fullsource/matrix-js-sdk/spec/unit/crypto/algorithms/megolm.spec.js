import '../../../olm-loader';
import * as algorithms from "../../../../src/crypto/algorithms";
import { MemoryCryptoStore } from "../../../../src/crypto/store/memory-crypto-store";
import { MockStorageApi } from "../../../MockStorageApi";
import * as testUtils from "../../../test-utils";
import { OlmDevice } from "../../../../src/crypto/OlmDevice";
import { Crypto } from "../../../../src/crypto";
import { logger } from "../../../../src/logger";
import { MatrixEvent } from "../../../../src/models/event";
import { TestClient } from "../../../TestClient";
import { Room } from "../../../../src/models/room";
import * as olmlib from "../../../../src/crypto/olmlib";

const MegolmDecryption = algorithms.DECRYPTION_CLASSES['m.megolm.v1.aes-sha2'];
const MegolmEncryption = algorithms.ENCRYPTION_CLASSES['m.megolm.v1.aes-sha2'];

const ROOM_ID = '!ROOM:ID';

const Olm = global.Olm;

describe("MegolmDecryption", function() {
    if (!global.Olm) {
        logger.warn('Not running megolm unit tests: libolm not present');
        return;
    }

    beforeAll(function() {
        return Olm.init();
    });

    let megolmDecryption;
    let mockOlmLib;
    let mockCrypto;
    let mockBaseApis;

    beforeEach(async function() {
        mockCrypto = testUtils.mock(Crypto, 'Crypto');
        mockBaseApis = {};

        const mockStorage = new MockStorageApi();
        const cryptoStore = new MemoryCryptoStore(mockStorage);

        const olmDevice = new OlmDevice(cryptoStore);

        megolmDecryption = new MegolmDecryption({
            userId: '@user:id',
            crypto: mockCrypto,
            olmDevice: olmDevice,
            baseApis: mockBaseApis,
            roomId: ROOM_ID,
        });

        // we stub out the olm encryption bits
        mockOlmLib = {};
        mockOlmLib.ensureOlmSessionsForDevices = jest.fn();
        mockOlmLib.encryptMessageForDevice =
            jest.fn().mockResolvedValue(undefined);
        megolmDecryption.olmlib = mockOlmLib;
    });

    describe('receives some keys:', function() {
        let groupSession;
        beforeEach(async function() {
            groupSession = new global.Olm.OutboundGroupSession();
            groupSession.create();

            // construct a fake decrypted key event via the use of a mocked
            // 'crypto' implementation.
            const event = new MatrixEvent({
                type: 'm.room.encrypted',
            });
            const decryptedData = {
                clearEvent: {
                    type: 'm.room_key',
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                        room_id: ROOM_ID,
                        session_id: groupSession.session_id(),
                        session_key: groupSession.session_key(),
                    },
                },
                senderCurve25519Key: "SENDER_CURVE25519",
                claimedEd25519Key: "SENDER_ED25519",
            };

            const mockCrypto = {
                decryptEvent: function() {
                    return Promise.resolve(decryptedData);
                },
            };

            await event.attemptDecryption(mockCrypto).then(() => {
                megolmDecryption.onRoomKeyEvent(event);
            });
        });

        it('can decrypt an event', function() {
            const event = new MatrixEvent({
                type: 'm.room.encrypted',
                room_id: ROOM_ID,
                content: {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    sender_key: "SENDER_CURVE25519",
                    session_id: groupSession.session_id(),
                    ciphertext: groupSession.encrypt(JSON.stringify({
                        room_id: ROOM_ID,
                        content: 'testytest',
                    })),
                },
            });

            return megolmDecryption.decryptEvent(event).then((res) => {
                expect(res.clearEvent.content).toEqual('testytest');
            });
        });

        it('can respond to a key request event', function() {
            const keyRequest = {
                userId: '@alice:foo',
                deviceId: 'alidevice',
                requestBody: {
                    room_id: ROOM_ID,
                    sender_key: "SENDER_CURVE25519",
                    session_id: groupSession.session_id(),
                },
            };

            return megolmDecryption.hasKeysForKeyRequest(
                keyRequest,
            ).then((hasKeys) => {
                expect(hasKeys).toBe(true);

                // set up some pre-conditions for the share call
                const deviceInfo = {};
                mockCrypto.getStoredDevice.mockReturnValue(deviceInfo);

                mockOlmLib.ensureOlmSessionsForDevices.mockResolvedValue({
                    '@alice:foo': { 'alidevice': {
                        sessionId: 'alisession',
                    } },
                });

                const awaitEncryptForDevice = new Promise((res, rej) => {
                    mockOlmLib.encryptMessageForDevice.mockImplementation(() => {
                        res();
                        return Promise.resolve();
                    });
                });

                mockBaseApis.sendToDevice = jest.fn();

                // do the share
                megolmDecryption.shareKeysWithDevice(keyRequest);

                // it's asynchronous, so we have to wait a bit
                return awaitEncryptForDevice;
            }).then(() => {
                // check that it called encryptMessageForDevice with
                // appropriate args.
                expect(mockOlmLib.encryptMessageForDevice).toBeCalledTimes(1);

                const call = mockOlmLib.encryptMessageForDevice.mock.calls[0];
                const payload = call[6];

                expect(payload.type).toEqual("m.forwarded_room_key");
                expect(payload.content).toMatchObject({
                    sender_key: "SENDER_CURVE25519",
                    sender_claimed_ed25519_key: "SENDER_ED25519",
                    session_id: groupSession.session_id(),
                    chain_index: 0,
                    forwarding_curve25519_key_chain: [],
                });
                expect(payload.content.session_key).toBeDefined();
            });
        });

        it("can detect replay attacks", function() {
            // trying to decrypt two different messages (marked by different
            // event IDs or timestamps) using the same (sender key, session id,
            // message index) triple should result in an exception being thrown
            // as it should be detected as a replay attack.
            const sessionId = groupSession.session_id();
            const cipherText = groupSession.encrypt(JSON.stringify({
                room_id: ROOM_ID,
                content: 'testytest',
            }));
            const event1 = new MatrixEvent({
                type: 'm.room.encrypted',
                room_id: ROOM_ID,
                content: {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    sender_key: "SENDER_CURVE25519",
                    session_id: sessionId,
                    ciphertext: cipherText,
                },
                event_id: "$event1",
                origin_server_ts: 1507753886000,
            });

            const successHandler = jest.fn();
            const failureHandler = jest.fn((err) => {
                expect(err.toString()).toMatch(
                    /Duplicate message index, possible replay attack/,
                );
            });

            return megolmDecryption.decryptEvent(event1).then((res) => {
                const event2 = new MatrixEvent({
                    type: 'm.room.encrypted',
                    room_id: ROOM_ID,
                    content: {
                        algorithm: 'm.megolm.v1.aes-sha2',
                        sender_key: "SENDER_CURVE25519",
                        session_id: sessionId,
                        ciphertext: cipherText,
                    },
                    event_id: "$event2",
                    origin_server_ts: 1507754149000,
                });

                return megolmDecryption.decryptEvent(event2);
            }).then(
                successHandler,
                failureHandler,
            ).then(() => {
                expect(successHandler).not.toHaveBeenCalled();
                expect(failureHandler).toHaveBeenCalled();
            });
        });

        it("allows re-decryption of the same event", function() {
            // in contrast with the previous test, if the event ID and
            // timestamp are the same, then it should not be considered a
            // replay attack
            const sessionId = groupSession.session_id();
            const cipherText = groupSession.encrypt(JSON.stringify({
                room_id: ROOM_ID,
                content: 'testytest',
            }));
            const event = new MatrixEvent({
                type: 'm.room.encrypted',
                room_id: ROOM_ID,
                content: {
                    algorithm: 'm.megolm.v1.aes-sha2',
                    sender_key: "SENDER_CURVE25519",
                    session_id: sessionId,
                    ciphertext: cipherText,
                },
                event_id: "$event1",
                origin_server_ts: 1507753886000,
            });

            return megolmDecryption.decryptEvent(event).then((res) => {
                return megolmDecryption.decryptEvent(event);
                // test is successful if no exception is thrown
            });
        });

        describe("session reuse and key reshares", () => {
            let megolmEncryption;
            let aliceDeviceInfo;
            let mockRoom;
            let olmDevice;

            beforeEach(async () => {
                mockCrypto.backupManager = {
                    backupGroupSession: () => {},
                };
                const mockStorage = new MockStorageApi();
                const cryptoStore = new MemoryCryptoStore(mockStorage);

                olmDevice = new OlmDevice(cryptoStore);
                olmDevice.verifySignature = jest.fn();
                await olmDevice.init();

                mockBaseApis.claimOneTimeKeys = jest.fn().mockReturnValue(Promise.resolve({
                    one_time_keys: {
                        '@alice:home.server': {
                            aliceDevice: {
                                'signed_curve25519:flooble': {
                                    key: 'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmI',
                                    signatures: {
                                        '@alice:home.server': {
                                            'ed25519:aliceDevice': 'totally valid',
                                        },
                                    },
                                },
                            },
                        },
                    },
                }));
                mockBaseApis.sendToDevice = jest.fn().mockResolvedValue(undefined);

                aliceDeviceInfo = {
                    deviceId: 'aliceDevice',
                    isBlocked: jest.fn().mockReturnValue(false),
                    isUnverified: jest.fn().mockReturnValue(false),
                    getIdentityKey: jest.fn().mockReturnValue(
                        'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE',
                    ),
                    getFingerprint: jest.fn().mockReturnValue(''),
                };

                mockCrypto.downloadKeys.mockReturnValue(Promise.resolve({
                    '@alice:home.server': {
                        aliceDevice: aliceDeviceInfo,
                    },
                }));

                mockCrypto.checkDeviceTrust.mockReturnValue({
                    isVerified: () => false,
                });

                megolmEncryption = new MegolmEncryption({
                    userId: '@user:id',
                    crypto: mockCrypto,
                    olmDevice: olmDevice,
                    baseApis: mockBaseApis,
                    roomId: ROOM_ID,
                    config: {
                        rotation_period_ms: 9999999999999,
                    },
                });
                mockRoom = {
                    getEncryptionTargetMembers: jest.fn().mockReturnValue(
                        [{ userId: "@alice:home.server" }],
                    ),
                    getBlacklistUnverifiedDevices: jest.fn().mockReturnValue(false),
                };
            });

            it("re-uses sessions for sequential messages", async function() {
                const ct1 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some text",
                });
                expect(mockRoom.getEncryptionTargetMembers).toHaveBeenCalled();

                // this should have claimed a key for alice as it's starting a new session
                expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalledWith(
                    [['@alice:home.server', 'aliceDevice']], 'signed_curve25519', 2000,
                );
                expect(mockCrypto.downloadKeys).toHaveBeenCalledWith(
                    ['@alice:home.server'], false,
                );
                expect(mockBaseApis.sendToDevice).toHaveBeenCalled();
                expect(mockBaseApis.claimOneTimeKeys).toHaveBeenCalledWith(
                    [['@alice:home.server', 'aliceDevice']], 'signed_curve25519', 2000,
                );

                mockBaseApis.claimOneTimeKeys.mockReset();

                const ct2 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some more text",
                });

                // this should *not* have claimed a key as it should be using the same session
                expect(mockBaseApis.claimOneTimeKeys).not.toHaveBeenCalled();

                // likewise they should show the same session ID
                expect(ct2.session_id).toEqual(ct1.session_id);
            });

            it("re-shares keys to devices it's already sent to", async function() {
                const ct1 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some text",
                });

                mockBaseApis.sendToDevice.mockClear();
                await megolmEncryption.reshareKeyWithDevice(
                    olmDevice.deviceCurve25519Key,
                    ct1.session_id,
                    '@alice:home.server',
                    aliceDeviceInfo,
                );

                expect(mockBaseApis.sendToDevice).toHaveBeenCalled();
            });

            it("does not re-share keys to devices whose keys have changed", async function() {
                const ct1 = await megolmEncryption.encryptMessage(mockRoom, "a.fake.type", {
                    body: "Some text",
                });

                aliceDeviceInfo.getIdentityKey = jest.fn().mockReturnValue(
                    'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWI',
                );

                mockBaseApis.sendToDevice.mockClear();
                await megolmEncryption.reshareKeyWithDevice(
                    olmDevice.deviceCurve25519Key,
                    ct1.session_id,
                    '@alice:home.server',
                    aliceDeviceInfo,
                );

                expect(mockBaseApis.sendToDevice).not.toHaveBeenCalled();
            });
        });
    });

    it("notifies devices that have been blocked", async function() {
        const aliceClient = (new TestClient(
            "@alice:example.com", "alicedevice",
        )).client;
        const bobClient1 = (new TestClient(
            "@bob:example.com", "bobdevice1",
        )).client;
        const bobClient2 = (new TestClient(
            "@bob:example.com", "bobdevice2",
        )).client;
        await Promise.all([
            aliceClient.initCrypto(),
            bobClient1.initCrypto(),
            bobClient2.initCrypto(),
        ]);
        const aliceDevice = aliceClient.crypto.olmDevice;
        const bobDevice1 = bobClient1.crypto.olmDevice;
        const bobDevice2 = bobClient2.crypto.olmDevice;

        const encryptionCfg = {
            "algorithm": "m.megolm.v1.aes-sha2",
        };
        const roomId = "!someroom";
        const room = new Room(roomId, aliceClient, "@alice:example.com", {});
        room.getEncryptionTargetMembers = async function() {
            return [{ userId: "@bob:example.com" }];
        };
        room.setBlacklistUnverifiedDevices(true);
        aliceClient.store.storeRoom(room);
        await aliceClient.setRoomEncryption(roomId, encryptionCfg);

        const BOB_DEVICES = {
            bobdevice1: {
                user_id: "@bob:example.com",
                device_id: "bobdevice1",
                algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                keys: {
                    "ed25519:Dynabook": bobDevice1.deviceEd25519Key,
                    "curve25519:Dynabook": bobDevice1.deviceCurve25519Key,
                },
                verified: 0,
            },
            bobdevice2: {
                user_id: "@bob:example.com",
                device_id: "bobdevice2",
                algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                keys: {
                    "ed25519:Dynabook": bobDevice2.deviceEd25519Key,
                    "curve25519:Dynabook": bobDevice2.deviceCurve25519Key,
                },
                verified: -1,
            },
        };

        aliceClient.crypto.deviceList.storeDevicesForUser(
            "@bob:example.com", BOB_DEVICES,
        );
        aliceClient.crypto.deviceList.downloadKeys = async function(userIds) {
            return this.getDevicesFromStore(userIds);
        };

        let run = false;
        aliceClient.sendToDevice = async (msgtype, contentMap) => {
            run = true;
            expect(msgtype).toBe("org.matrix.room_key.withheld");
            delete contentMap["@bob:example.com"].bobdevice1.session_id;
            delete contentMap["@bob:example.com"].bobdevice2.session_id;
            expect(contentMap).toStrictEqual({
                '@bob:example.com': {
                    bobdevice1: {
                        algorithm: "m.megolm.v1.aes-sha2",
                        room_id: roomId,
                        code: 'm.unverified',
                        reason:
                        'The sender has disabled encrypting to unverified devices.',
                        sender_key: aliceDevice.deviceCurve25519Key,
                    },
                    bobdevice2: {
                        algorithm: "m.megolm.v1.aes-sha2",
                        room_id: roomId,
                        code: 'm.blacklisted',
                        reason: 'The sender has blocked you.',
                        sender_key: aliceDevice.deviceCurve25519Key,
                    },
                },
            });
        };

        const event = new MatrixEvent({
            type: "m.room.message",
            sender: "@alice:example.com",
            room_id: roomId,
            event_id: "$event",
            content: {
                msgtype: "m.text",
                body: "secret",
            },
        });
        await aliceClient.crypto.encryptEvent(event, room);

        expect(run).toBe(true);

        aliceClient.stopClient();
        bobClient1.stopClient();
        bobClient2.stopClient();
    });

    it("notifies devices when unable to create olm session", async function() {
        const aliceClient = (new TestClient(
            "@alice:example.com", "alicedevice",
        )).client;
        const bobClient = (new TestClient(
            "@bob:example.com", "bobdevice",
        )).client;
        await Promise.all([
            aliceClient.initCrypto(),
            bobClient.initCrypto(),
        ]);
        const aliceDevice = aliceClient.crypto.olmDevice;
        const bobDevice = bobClient.crypto.olmDevice;

        const encryptionCfg = {
            "algorithm": "m.megolm.v1.aes-sha2",
        };
        const roomId = "!someroom";
        const aliceRoom = new Room(roomId, aliceClient, "@alice:example.com", {});
        const bobRoom = new Room(roomId, bobClient, "@bob:example.com", {});
        aliceClient.store.storeRoom(aliceRoom);
        bobClient.store.storeRoom(bobRoom);
        await aliceClient.setRoomEncryption(roomId, encryptionCfg);
        await bobClient.setRoomEncryption(roomId, encryptionCfg);

        aliceRoom.getEncryptionTargetMembers = async () => {
            return [
                {
                    userId: "@alice:example.com",
                    membership: "join",
                },
                {
                    userId: "@bob:example.com",
                    membership: "join",
                },
            ];
        };
        const BOB_DEVICES = {
            bobdevice: {
                user_id: "@bob:example.com",
                device_id: "bobdevice",
                algorithms: [olmlib.OLM_ALGORITHM, olmlib.MEGOLM_ALGORITHM],
                keys: {
                    "ed25519:bobdevice": bobDevice.deviceEd25519Key,
                    "curve25519:bobdevice": bobDevice.deviceCurve25519Key,
                },
                known: true,
                verified: 1,
            },
        };

        aliceClient.crypto.deviceList.storeDevicesForUser(
            "@bob:example.com", BOB_DEVICES,
        );
        aliceClient.crypto.deviceList.downloadKeys = async function(userIds) {
            return this.getDevicesFromStore(userIds);
        };

        aliceClient.claimOneTimeKeys = async () => {
            // Bob has no one-time keys
            return {
                one_time_keys: {},
            };
        };

        const sendPromise = new Promise((resolve, reject) => {
            aliceClient.sendToDevice = async (msgtype, contentMap) => {
                expect(msgtype).toBe("org.matrix.room_key.withheld");
                expect(contentMap).toStrictEqual({
                    '@bob:example.com': {
                        bobdevice: {
                            algorithm: "m.megolm.v1.aes-sha2",
                            code: 'm.no_olm',
                            reason: 'Unable to establish a secure channel.',
                            sender_key: aliceDevice.deviceCurve25519Key,
                        },
                    },
                });
                resolve();
            };
        });

        const event = new MatrixEvent({
            type: "m.room.message",
            sender: "@alice:example.com",
            room_id: roomId,
            event_id: "$event",
            content: {},
        });
        await aliceClient.crypto.encryptEvent(event, aliceRoom);
        await sendPromise;
    });

    it("throws an error describing why it doesn't have a key", async function() {
        const aliceClient = (new TestClient(
            "@alice:example.com", "alicedevice",
        )).client;
        const bobClient = (new TestClient(
            "@bob:example.com", "bobdevice",
        )).client;
        await Promise.all([
            aliceClient.initCrypto(),
            bobClient.initCrypto(),
        ]);
        const bobDevice = bobClient.crypto.olmDevice;

        const roomId = "!someroom";

        aliceClient.crypto.onToDeviceEvent(new MatrixEvent({
            type: "org.matrix.room_key.withheld",
            sender: "@bob:example.com",
            content: {
                algorithm: "m.megolm.v1.aes-sha2",
                room_id: roomId,
                session_id: "session_id",
                sender_key: bobDevice.deviceCurve25519Key,
                code: "m.blacklisted",
                reason: "You have been blocked",
            },
        }));

        await expect(aliceClient.crypto.decryptEvent(new MatrixEvent({
            type: "m.room.encrypted",
            sender: "@bob:example.com",
            event_id: "$event",
            room_id: roomId,
            content: {
                algorithm: "m.megolm.v1.aes-sha2",
                ciphertext: "blablabla",
                device_id: "bobdevice",
                sender_key: bobDevice.deviceCurve25519Key,
                session_id: "session_id",
            },
        }))).rejects.toThrow("The sender has blocked you.");
    });

    it("throws an error describing the lack of an olm session", async function() {
        const aliceClient = (new TestClient(
            "@alice:example.com", "alicedevice",
        )).client;
        const bobClient = (new TestClient(
            "@bob:example.com", "bobdevice",
        )).client;
        await Promise.all([
            aliceClient.initCrypto(),
            bobClient.initCrypto(),
        ]);
        aliceClient.crypto.downloadKeys = async () => {};
        const bobDevice = bobClient.crypto.olmDevice;

        const roomId = "!someroom";

        const now = Date.now();

        aliceClient.crypto.onToDeviceEvent(new MatrixEvent({
            type: "org.matrix.room_key.withheld",
            sender: "@bob:example.com",
            content: {
                algorithm: "m.megolm.v1.aes-sha2",
                room_id: roomId,
                session_id: "session_id",
                sender_key: bobDevice.deviceCurve25519Key,
                code: "m.no_olm",
                reason: "Unable to establish a secure channel.",
            },
        }));

        await new Promise((resolve) => {
            setTimeout(resolve, 100);
        });

        await expect(aliceClient.crypto.decryptEvent(new MatrixEvent({
            type: "m.room.encrypted",
            sender: "@bob:example.com",
            event_id: "$event",
            room_id: roomId,
            content: {
                algorithm: "m.megolm.v1.aes-sha2",
                ciphertext: "blablabla",
                device_id: "bobdevice",
                sender_key: bobDevice.deviceCurve25519Key,
                session_id: "session_id",
            },
            origin_server_ts: now,
        }))).rejects.toThrow("The sender was unable to establish a secure channel.");
    });

    it("throws an error to indicate a wedged olm session", async function() {
        const aliceClient = (new TestClient(
            "@alice:example.com", "alicedevice",
        )).client;
        const bobClient = (new TestClient(
            "@bob:example.com", "bobdevice",
        )).client;
        await Promise.all([
            aliceClient.initCrypto(),
            bobClient.initCrypto(),
        ]);
        const bobDevice = bobClient.crypto.olmDevice;
        aliceClient.crypto.downloadKeys = async () => {};

        const roomId = "!someroom";

        const now = Date.now();

        // pretend we got an event that we can't decrypt
        aliceClient.crypto.onToDeviceEvent(new MatrixEvent({
            type: "m.room.encrypted",
            sender: "@bob:example.com",
            content: {
                msgtype: "m.bad.encrypted",
                algorithm: "m.megolm.v1.aes-sha2",
                session_id: "session_id",
                sender_key: bobDevice.deviceCurve25519Key,
            },
        }));

        await new Promise((resolve) => {
            setTimeout(resolve, 100);
        });

        await expect(aliceClient.crypto.decryptEvent(new MatrixEvent({
            type: "m.room.encrypted",
            sender: "@bob:example.com",
            event_id: "$event",
            room_id: roomId,
            content: {
                algorithm: "m.megolm.v1.aes-sha2",
                ciphertext: "blablabla",
                device_id: "bobdevice",
                sender_key: bobDevice.deviceCurve25519Key,
                session_id: "session_id",
            },
            origin_server_ts: now,
        }))).rejects.toThrow("The secure channel with the sender was corrupted.");
    });
});