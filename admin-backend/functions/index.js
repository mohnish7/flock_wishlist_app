const functions = require("firebase-functions")
const express = require("express")
const cors = require("cors")
const admin = require("firebase-admin")
const axios = require('axios')
const stripe = require('stripe')('stripe_key_live');
admin.initializeApp();
const db = admin.firestore()



const app = express()
app.use(cors({origin: ["list of whitelisted links"]}))
//app.use(cors())
//app.use(cors({origin: '*'}))


/*

DIFFBOT FUNCTIONS BEGIN

*/

app.post("/get-product-from-link", async (req, res) => {
  try {
    let productData = await axios.get(`https://api.diffbot.com/v3/product?token=token&url=${req.body.url}`)
    res.status(200).send(productData.data)
  } catch {
    res.status(400).send(JSON.stringify(Error()))
  }
})


/*

DIFFBOT FUNCTIONS ENDS

*/



/*

STRIPE FUNCTIONS BEGIN

*/



app.post('/stripe-payment', async (request, response) => {
  const payload = request.rawBody;
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(payload, sig, 'stripe_key');
  } catch (err) {
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the checkout.session.completed event
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object

    await db.collection('wishlistItems').doc(session.metadata.itemId).update({"currentContribution": admin.firestore.FieldValue.increment((Number(session.amount_total)/100-0.3)/1.029), "lastUpdated": admin.firestore.Timestamp.fromDate(new Date())})
    response.status(200).send("checkout complete")

  } 

})

app.post('/stripe-verification', async (request, response) => {
  const payload = request.rawBody;
  const sig = request.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(payload, sig, 'stripe_key');
  } catch (err) {
    return response.status(400).send(`Webhook Error: ${err.message}`);
  }

  //handle account.updated event
  if (event.type === 'account.updated') {
    const session = event.data.object
    if (session.capabilities.card_payments === "active" && session.capabilities.transfers === "active") {
      await db.collection('users').where("stripeId", "==", session.id).get().then((querySnapshot) => {
        querySnapshot.forEach(doc => {
          doc.ref.update({"stripeVerified": true, "lastUpdated": admin.firestore.Timestamp.fromDate(new Date())})
        })
      })
      
      //await db.collection('users').where("stripeId", "===", session.id).update({"stripeVerified": true, "lastUpdated": admin.firestore.Timestamp.fromDate(new Date())})
      response.status(200).send('account verified')
    } else if (session.requirements.eventually_due.length === 0) {
      await db.collection('users').where("stripeId", "==", session.id).get().then((querySnapshot) => {
        querySnapshot.forEach(doc => {
          doc.ref.update({"stripeOnboarded": true, "lastUpdated": admin.firestore.Timestamp.fromDate(new Date())})
        })
      })
      
      //await db.collection('users').where("stripeId", "===", session.id).update({"stripeVerified": true, "lastUpdated": admin.firestore.Timestamp.fromDate(new Date())})
      response.status(200).send('account onboarded')
    } 
    
    else response.status(200).send('neither verification nor onboarding changed')
  }


})

app.post("/create-checkout-session", async (req, res) => {
  try {
    var session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        //cents
        name: req.body.item,
        amount: parseInt(Math.round(((parseFloat(req.body.amount) / (1-0.029) * 100) + 30 + Number.EPSILON) * 100) / 100),
        currency: 'usd',
        quantity: 1,
      }],
      metadata: {
        itemId: req.body.itemId,
        user: req.body.username 
      },
      payment_intent_data: {
        application_fee_amount: parseInt(Math.round((parseFloat(req.body.amount) * 100 * 0.03 + 30 + Number.EPSILON) * 100) / 100),//req.body.accountType === "charity" ? parseInt(Math.round((parseFloat(req.body.amount) * 100 * 0.03 + 30 + Number.EPSILON) * 100) / 100) : parseInt(Math.round((parseFloat(req.body.amount) * 100 * 0.08 + 30 + Number.EPSILON) * 100) / 100),
        transfer_data: {
          destination: req.body.connectId
        },
      },
      success_url: `https://myflock.app/public/${req.body.wishlistId}`,
      cancel_url: `https://myflock.app/public/${req.body.wishlistId}`
    })


    res.status(200).send(JSON.stringify(session))

  } catch {
    res.status(400).send(Error())
  }
})

app.post("/get-account-link", async (req, res) => {

 try {
    var loginLink = await stripe.accounts.createLoginLink(req.body.userId)
  
    
    res.status(200).send(JSON.stringify(loginLink))
  } catch {
    res.status(400).send(Error())
  }

})

app.post("/stripe-complete-onboarding", async (req, res) => {

  try {
    var accountLink = await stripe.accountLinks.create({
      account: req.body.stripeId,
      refresh_url: 'https://myflock.app/dashboard',
      return_url: 'https://myflock.app/dashboard',
      type: 'account_onboarding',
      collect: 'eventually_due'
  })  
  
  res.status(200).send(JSON.stringify(accountLink))
  } catch {
    res.status(400).send(Error())
  }
})

app.post("/stripe-onboard-user", async (req, res) => {

  var account = await stripe.accounts.create({
    type: 'express',
    business_type: 'individual',
    individual: {
      email: req.body.email,
    },
    business_profile : {
      mcc: '7299',
      name: req.body.username,
      product_description: 'Through Flock, your friends, family, and supporters can help you get what you want',
      url: "myflock.app/@" + req.body.username
    },
    capabilities: {
      card_payments: {requested: true},
      transfers: {requested: true},
    },
  })

  var accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: 'https://myflock.app/onboarding',
      return_url: 'https://myflock.app/dashboard',
      type: 'account_onboarding',
  })

  //'https://myflock.app/onboarding'
  //'https://myflock.app/dashboard'


  res.status(200).send([accountLink, { "account_id": account.id }])
  //res.status(200).send(JSON.stringify(accountLink))

})

/*

STRIPE FUNCTIONS END

*/

/*

USER-SPECIFIC FUNCTIONS BEGIN

*/

app.post("/create-user", async (req, res) => {
  await db.collection('users').doc(req.body.userId).set({"username": req.body.username, "email": req.body.email, "accountType": "individual", "bio": null, "isActive": true, "twitter": null, "snapchat": null, "instagram": null,  "tiktok": null, "youtube": null, "twitter": null, "stripeVerified": false, "stripeId": null, "stripeOnboarded": null, "photoURL": null, "lastUpdated": admin.firestore.Timestamp.fromDate(new Date())})
  res.status(201).send()
})

app.post("/check-username-availability", async (req, res) => {
  const snapshot = await db.collection('users').where("username", "==", req.body.username).get()
  res.status(200).send(JSON.stringify(snapshot.docs.length))
})

//this is for public user data on wishlist item page for Stripe
app.post("/public-data", async (req, res) => {
  let usersData = []
  await db.collection('users').doc(req.body.username).get().then(cred => {
    usersData.push({"id": cred.id, "data": cred.data()})
  })

  res.status(200).send(JSON.stringify(usersData))

  })

app.post("/public-profile", async (req, res) => {
  const snapshot = await db.collection('users').where("username", "==", req.body.username).get()
  
  let usersData = [];
  snapshot.forEach((doc) => {
      let id = doc.id;
      let data = doc.data();
  
      usersData.push({ id, ...data })
  })

  res.status(200).send(JSON.stringify(usersData))

  })


/*

USER-SPECIFIC FUNCTIONS END

*/


/*

WISHLIST-SPECIFIC FUNCTIONS BEGIN

*/

app.post("/public-wishlist", async (req, res) => {
    const snapshot = await db.collection('wishlist').where("username", "==", req.body.userId).where("live", "==", true).get()
  
    let wishlistData = [];
    snapshot.forEach((doc) => {
      let id = doc.id;
      let data = doc.data();
  
      wishlistData.push({ id, ...data })
    })

    res.status(200).send(JSON.stringify(wishlistData))

})

app.post("/wishlist-exists", async (req, res) => {
  let wishlistData = []
  await db.collection('wishlist').doc(req.body.wishlistId).get().then(cred => {
    wishlistData.push({"id": cred.id, "data": cred.data()})
  })

  res.status(200).send(JSON.stringify(wishlistData))

})

app.post("/public-wishlist-items", async (req, res) => {
  const snapshot = await db.collection('wishlistItems').where("wishlistId", "==", req.body.wishlistId).where("live", "==", true).get()

  let wishlistData = [];
  snapshot.forEach((doc) => {
    let id = doc.id;
    let data = doc.data();

    wishlistData.push({ id, ...data })
  })

  res.status(200).send(JSON.stringify(wishlistData))

})


/*

WISHLIST-SPECIFIC FUNCTIONS END

*/


exports.api = functions.https.onRequest(app);