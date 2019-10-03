/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
//'use strict';

const functions = require('firebase-functions');
const gcs = require('@google-cloud/storage')({
    projectId: 'causecho-ab079',
    keyFilename: 'causecho-1b87c31b88f1.json'
});
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');
const moment = require('moment');

let admin = require('firebase-admin');
admin.initializeApp(functions.config().firebase);

exports.sendPushForDonate = functions.firestore.document('/payments/{paymentID}').onCreate(event => {
    let data = event.data.data();
    if(data == null)   
        return null;

    let msg = `Thank you for donating ${data.mc_gross} ${data.mc_currency}.`;
    let uid = data.uid;
    let event_id = data.event_id;

    // Update activist information on echo-ing the cause
    if (uid != null) {
        updateRating(uid)
    }

    return admin.firestore().doc(`users/${uid}`).get()
        .then(user_data => {
            if (user_data == null)
                return;

            let user = user_data.data();
            let tokens = [];

            if (user.tokens != null) {
                Object.keys(user.tokens).forEach(token => {
                    if (user.tokens[token] == true) tokens.push(token);
                });
            }
            console.log('Payment ID:', event.data.id);
            console.log('Tokens sent: ', tokens);

            let payload = {
                notification: {
                    title: 'CausEcho donation',
                    body: msg,
                    sound: 'default',
                    badge: '0',
                    icon: "my_notification_icon",
                    color: "#9acbfc"
                },
                data: {
                    event_id: event_id
                }
            };

            if (tokens.length > 0)
                return admin.messaging().sendToDevice(tokens, payload);
            else
                return null;
        })
        .catch(error => console.log(error));
});

exports.donate = functions.https.onRequest((req, res) => {
    let trans = req.body;

    if (trans.payment_status == 'Completed') {
        let payment = {};
        payment.item_name = trans.item_name;
        payment.payment_date = trans.payment_date;
        payment.quantity = trans.quantity;
        payment.payment_gross = trans.payment_gross;
        payment.payment_fee = trans.payment_fee;
        payment.mc_gross = trans.mc_gross;
        payment.mc_fee = trans.mc_fee;
        payment.mc_currency = trans.mc_currency;
        payment.txn_id = trans.txn_id;
        payment.receive_id = trans.receive_id;
        payment.receiver_email = trans.receiver_email;
        payment.business = trans.business;
        payment.payer_id = trans.payer_id;
        payment.payer_email = trans.payer_email;
        payment.first_name = trans.first_name;
        payment.last_name = trans.last_name;
        payment.residence_country = trans.residence_country;

        let custom = trans.custom.split(".");
        if (custom[0] != null)
            payment.uid = custom[0];
        if (custom[1] != null) {
            payment.event_id = custom[1];

            admin.firestore().doc(`events/${custom[1]}`)
                .get()
                .then(event_data => {
                    if (event_data != null) {
                        let event = event_data.data();
                        let donated = Number(event.donated == null ? 0 : event.donated) + Number(trans.payment_gross == null ? 0 : trans.payment_gross);
                        admin.firestore().doc(`events/${custom[1]}`).set({ donated: donated }, { merge: true });
                    }
                })
                .catch(err => console.log(err));
        }

        let temp = JSON.stringify(payment);
        admin.firestore().collection(`payments`).add(JSON.parse(temp));
        console.log(`${trans.item_name} - PayPal successfull transaction.`);
    }
    res.status(200).send(`PayPal transaction processed.`);

    //res.set('Cache-Control', 'public, max-age=300, s-maxage=600');
    //res.set('Vary', 'Accept-Encoding, X-My-Custom-Header');
    //res.status(200).send(`<!doctype html><head><title>Time</title></head><body></body></html>`);
});

exports.cronJob = functions.pubsub.topic('hourly-tick').onPublish((event) => {
    console.log("Cron-job executed!");

    const now = moment().subtract(1, 'hour');
    admin.firestore().collection('videos').where(`live`, '==', true)
        .get()
        .then(value => {
            value.docs.forEach(doc => {
                let data = doc.data();
                if (data.created <= now) {
                    admin.firestore().doc(`videos/${data.video_id}`).set({ live: false }, { merge: true });
                }
            })
            return null;
        })
        .catch(err => reject(err));

    return null;
});

/** add/update advocacy groups on user add/update **/
exports.addOrUpdateGroupsAndActivists = functions.firestore.document('/users/{userId}').onWrite(event => {
    let data = event.data.data();
    if (data == null)
        return null;

    let uid = event.data.id;

    let activist = { description: data.description, display_name: data.display_name, email: data.email, photo_url: data.photo_url, uid: data.uid };
    if (!event.data.previous.exists) activist.rating = 0;
    activist = JSON.stringify(activist);

    admin.firestore().doc(`activists/${uid}`).set(JSON.parse(activist), { merge: true }).catch(error => console.log(error));

    if (data.type == 1) {
        let temp = JSON.stringify({ description: data.description, display_name: data.display_name, email: data.email, hide_email: data.hide_email, photo_path: data.photo_path, photo_url: data.photo_url, uid: data.uid });
        admin.firestore().doc(`groups/${uid}`).set(JSON.parse(temp), { merge: true }).catch(error => console.log(error));
    }

    if (event.data.previous.exists) {
        if (event.data.previous.data().display_name != data.display_name) {
            admin.firestore().collection('events').where('uid', '==', uid).get()
                .then(snapshots => {
                    snapshots.docs.forEach(snapshot => {
                        admin.firestore().doc(`events/${snapshot.id}`)
                            .set({ advocacy_group: data.display_name }, { merge: true })
                            .catch(error => console.log(error));
                    });
                    return null;
                })
                .catch(error => console.log(error));
            admin.firestore().collection('petitions').where('uid', '==', uid).get()
                .then(snapshots => {
                    snapshots.docs.forEach(snapshot => {
                        admin.firestore().doc(`petitions/${snapshot.id}`)
                            .set({ advocacy_group: data.display_name }, { merge: true });
                    });
                    return null;
                })
                .catch(error => console.log(error));
        }
        if (event.data.previous.data().hide_email != data.hide_email) {
            admin.firestore().collection('events').where('uid', '==', uid).get()
                .then(snapshots => {
                    snapshots.docs.forEach(snapshot => {
                        admin.firestore().doc(`events/${snapshot.id}`)
                            .set({ advocacy_email: data.hide_email == true ? '[email hidden]' : data.email }, { merge: true });
                    });
                    return null;
                })
                .catch(error => console.log(error));
            admin.firestore().collection('petitions').where('uid', '==', uid).get()
                .then(snapshots => {
                    snapshots.docs.forEach(snapshot => {
                        admin.firestore().doc(`petitions/${snapshot.id}`)
                            .set({ advocacy_email: data.hide_email == true ? '[email hidden]' : data.email }, { merge: true });
                    });
                    return null;
                })
                .catch(error => console.log(error));
        }
    }

    return null;
});


exports.updateActivistRatingOnPetitionSign = functions.firestore.document('/petitions/{petitionID}').onUpdate(event => {
    let data = event.data.data();
    if (data == null)
        return null;

    let previous = event.data.previous.data();

    // Update activist information on petition sign
    if (data.users != null) {
        let keys = Object.keys(data.users);
        let prev_keys = previous == null || previous.users == null ? [] : Object.keys(previous.users);

        keys.forEach(key => {
            if (!prev_keys.some((value, index) => { return key == value; })) {
                updateRating(key);
            }
        })
    }
    return null;
});

exports.updateActivistRatingOnLiveFeed = functions.firestore.document('/videos/{videoID}').onWrite(event => {
    let data = event.data.data();
    if (data == null)
        return null;

    let previous = event.data.previous.data();
    let uid = data.uid;
    let live = data.live == null ? false : data.live;

    // Update activist information on echo-ing the cause
    if (uid != null && (live == true && (previous == null || previous.live != live))) {
        updateRating(uid);
    }
    return null;
});


//** send push notification for events to subscribed users */
exports.sendPushForEvent = functions.firestore.document('/events/{eventId}').onWrite(event => {
    let data = event.data.data();
    if (data == null)
        return null;

    let uid = event.data.id;
    let previous = event.data.previous.data();

    // Update activist information on echo-ing the cause
    if (data.users != null) {
        let keys = Object.keys(data.users);
        let prev_keys = previous == null || previous.users == null ? [] : Object.keys(previous.users);

        keys.forEach(key => {
            if (!prev_keys.some((value, index) => { return key == value; })) {
                updateRating(key);
            }
        });
    }

    if (previous != null) {
        if (JSON.stringify(data.location) == JSON.stringify(previous.location) &&
            JSON.stringify(data.start) == JSON.stringify(previous.start) &&
            JSON.stringify(data.end) == JSON.stringify(previous.end)
        )
            return null;
    }

    let msg = `Time and/or location has been changed: ${event.data.data().name}`;
    if (previous == null)
        msg = `New event has been added: ${event.data.data().name}`;

    return loadUsers(data.uid)
        .then(users => {
            let tokens = [];
            for (let user of users) {
                if (user.tokens != null) {
                    Object.keys(user.tokens).forEach(token => {
                        if (user.tokens[token] == true) tokens.push(token);
                    });
                }
            }
            console.log('Event ID:', event.data.id);
            console.log('Tokens sent: ', tokens);

            let payload = {
                notification: {
                    title: 'CausEcho notification',
                    body: msg,
                    sound: 'default',
                    badge: '0',
                    icon: "my_notification_icon",
                    color: "#9acbfc"
                },
                data: {
                    event_id: event.data.id
                }
            };

            if (tokens.length > 0)
                return admin.messaging().sendToDevice(tokens, payload);
            else
                return null;
        })
        .catch(error => console.log(error));
});

exports.removeUser = functions.firestore.document('/users/{userId}').onDelete(event => {
    let data = event.data.previous.data();
    let uid = event.data.id;
    let bucket = gcs.bucket('causecho-ab079.appspot.com');

    admin.auth().deleteUser(uid)

    // remove events
    admin.firestore().collection(`events`).where('uid', '==', uid).get()
        .then(snapshots => {
            snapshots.docs.forEach(snapshot => {
                if (snapshot.data().photo_path != null)
                    bucket.file(snapshot.data().photo_path).delete();
                admin.firestore().doc(`events/${snapshot.id}`).delete()
            });
            return null;
        });
    // remove petitions
    admin.firestore().collection(`petitions`).where('uid', '==', uid).get()
        .then(snapshots => {
            snapshots.docs.forEach(snapshot => {
                if (snapshot.data().photo_path != null)
                    bucket.file(snapshot.data().photo_path).delete();
                admin.firestore().doc(`petitions/${snapshot.id}`).delete();
            });
            return null;
        });
    // remove pictures
    admin.firestore().collection(`pictures`).where('uid', '==', uid).get()
        .then(snapshots => {
            snapshots.docs.forEach(snapshot => {
                if (snapshot.data().thumb_path != null)
                    bucket.file(snapshot.data().thumb_path).delete();
                if (snapshot.data().url_path != null)
                    bucket.file(snapshot.data().url_path).delete();
                admin.firestore().doc(`pictures/${snapshot.id}`).delete();
            });
            return null;
        });
    // remove videos
    admin.firestore().collection(`videos`).where('uid', '==', uid).get()
        .then(snapshots => {
            snapshots.docs.forEach(snapshot => {
                if (snapshot.data().thumb_path != null)
                    bucket.file(snapshot.data().thumb_path).delete();
                if (snapshot.data().url_path != null)
                    bucket.file(snapshot.data().url_path).delete();
                admin.firestore().doc(`videos/${snapshot.id}`).delete();
            });
            return null;
        })

    if (data.photo_path != null)
        gcs.bucket('causecho-ab079.appspot.com').file(data.photo_path).delete();

    admin.firestore().doc(`users/${uid}`).get()
        .then(snapshot => {
            if (snapshot.exists)
                admin.firestore().doc(`users/${uid}`).delete().then(() => {
                    admin.auth().deleteUser(uid);
                    return null;
                });
        });

    return null;
});

//** PRIVATE FUNCTIONS **/

function loadUsers(uid) {
    let dbRef = admin.firestore().collection('users').where(`subscribed_to.${uid}`, '==', true);
    let defer = new Promise((resolve, reject) => {
        dbRef.get()
            .then(value => {
                let users = [];
                value.docs.forEach(doc => {
                    let data = doc.data();
                    if (data.alert == null || data.alert == true)
                        users.push(doc.data());
                })
                resolve(users);
                return null;
            })
            .catch(err => reject(err));
    });
    return defer;
}

function updateRating(uid) {
    admin.firestore().doc(`activists/${uid}`).get()
        .then(snapshot => {
            if (!snapshot.exists) {
                admin.firestore().doc(`users/${uid}`).get()
                    .then(snapshot_user => {
                        if (snapshot_user.exists) {
                            let user = snapshot_user.data();
                            let activist = JSON.stringify({ description: user.description, display_name: user.display_name, email: user.email, photo_url: user.photo_url, uid: data.uid, rating: 1 });
                            admin.firestore().doc(`activists/${uid}`).set(JSON.parse(activist), { merge: true });
                        }
                    });
            } else {
                let activist = snapshot.data();
                let rating = activist.rating == null ? 1 : activist.rating + 1;
                admin.firestore().doc(`activists/${uid}`).set({ rating: rating }, { merge: true });
            }
        });
}