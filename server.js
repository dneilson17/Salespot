import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { Server as SocketIOServer } from 'socket.io';
import Stripe from 'stripe';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || (IS_PROD ? crypto.randomBytes(48).toString('hex') : 'development-only-change-me');
if (IS_PROD && !process.env.JWT_SECRET) console.warn('WARNING: JWT_SECRET is not set; sessions will reset whenever the server restarts.');
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

const db = new DatabaseSync(path.join(__dirname, 'salespot.db'));
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  avatar_url TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS seller_profiles (
  user_id INTEGER PRIMARY KEY,
  display_name TEXT,
  bio TEXT,
  phone TEXT,
  city TEXT,
  state TEXT,
  rating REAL NOT NULL DEFAULT 5,
  sales_count INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seller_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('auction','marketplace','yard_sale','estate_sale')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'Other',
  price_cents INTEGER,
  start_bid_cents INTEGER,
  current_bid_cents INTEGER,
  reserve_cents INTEGER,
  bid_increment_cents INTEGER  DEFAULT 100,
  starts_at TEXT,
  ends_at TEXT,
  event_date TEXT,
  event_time TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  latitude REAL,
  longitude REAL,
  shipping INTEGER NOT NULL DEFAULT 0,
  local_pickup INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('draft','active','sold','ended','removed')),
  featured INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(seller_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS listing_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  bidder_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE,
  FOREIGN KEY(bidder_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS watchlist (
  user_id INTEGER NOT NULL,
  listing_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, listing_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_id INTEGER NOT NULL,
  receiver_id INTEGER NOT NULL,
  listing_id INTEGER,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(receiver_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(listing_id) REFERENCES listings(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  buyer_id INTEGER NOT NULL,
  seller_id INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  stripe_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','cancelled','refunded')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(listing_id) REFERENCES listings(id),
  FOREIGN KEY(buyer_id) REFERENCES users(id),
  FOREIGN KEY(seller_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_listings_type_status ON listings(type,status);
CREATE INDEX IF NOT EXISTS idx_bids_listing ON bids(listing_id,amount_cents DESC);
CREATE INDEX IF NOT EXISTS idx_messages_users ON messages(sender_id,receiver_id,created_at);
`);

const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (count === 0) seed();
ensureAdmin();

function cleanText(value, max=200){ return String(value ?? '').trim().slice(0,max); }
function validEmail(value){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value||'')); }

function seed(){
  const pass = bcrypt.hashSync('Demo123!', 12);
  const insertUser = db.prepare('INSERT INTO users(name,email,password_hash,verified) VALUES(?,?,?,1)');
  const u1 = Number(insertUser.run('Sarah Miller','sarah@example.com',pass).lastInsertRowid);
  const u2 = Number(insertUser.run('Farm Equipment Co.','farm@example.com',pass).lastInsertRowid);
  const u3 = Number(insertUser.run('Historic Home Sales','estate@example.com',pass).lastInsertRowid);
  db.prepare('INSERT INTO seller_profiles(user_id,display_name,bio,city,state,rating,sales_count) VALUES(?,?,?,?,?,?,?)').run(u1,'Sarah Miller','Local seller and collector','Dover','DE',4.9,48);
  db.prepare('INSERT INTO seller_profiles(user_id,display_name,bio,city,state,rating,sales_count) VALUES(?,?,?,?,?,?,?)').run(u2,'Farm Equipment Co.','Tractors, implements and farm equipment','Dover','DE',4.8,126);
  db.prepare('INSERT INTO seller_profiles(user_id,display_name,bio,city,state,rating,sales_count) VALUES(?,?,?,?,?,?,?)').run(u3,'Historic Home Estate Sales','Professional estate sale company','Smyrna','DE',4.9,88);
  const add = db.prepare(`INSERT INTO listings(seller_id,type,title,description,category,price_cents,start_bid_cents,current_bid_cents,bid_increment_cents,ends_at,event_date,event_time,address,city,state,latitude,longitude,shipping,local_pickup,featured)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const now = Date.now();
  const items = [
    [u1,'auction','1967 Chevrolet Camaro SS','Restored classic Camaro SS.','Vehicles',null,4000000,4250000,50000,new Date(now+2*86400000+14*3600000).toISOString(),null,null,'','Dover','DE',39.1582,-75.5244,1,1,1],
    [u1,'auction','1.25 ct Diamond Ring','Certified diamond engagement ring.','Collectibles',null,700000,875000,25000,new Date(now+26*3600000).toISOString(),null,null,'','Dover','DE',39.148,-75.52,1,1,1],
    [u2,'auction','John Deere 5100E Tractor','Low-hour tractor, field ready.','Equipment',null,1400000,1620000,50000,new Date(now+34*3600000).toISOString(),null,null,'','Dover','DE',39.17,-75.56,0,1,1],
    [u1,'auction','Morgan Silver Dollar (1884)','Collector grade silver dollar.','Collectibles',null,25000,32000,1000,new Date(now+12*3600000).toISOString(),null,null,'','Smyrna','DE',39.30,-75.61,1,1,0],
    [u1,'marketplace','Antique Oak Dresser','Solid oak dresser in excellent condition.','Home & Garden',47500,null,null,null,null,null,null,'','Dover','DE',39.14,-75.55,0,1,1],
    [u2,'marketplace','Utility Trailer','Heavy-duty tandem axle utility trailer.','Vehicles',320000,null,null,null,null,null,null,'','Camden','DE',39.11,-75.54,0,1,0],
    [u1,'yard_sale','Smith Family Yard Sale','Furniture, tools, antiques, household goods.','Home & Garden',null,null,null,null,null,'2026-09-12','7:00 AM – 2:00 PM','Near downtown Dover','Dover','DE',39.160,-75.53,0,1,1],
    [u3,'estate_sale','Historic Home Estate Sale','Antiques, furniture and collectibles from a historic home.','Collectibles',null,null,null,null,null,'2026-09-13','9:00 AM – 4:00 PM','Smyrna area','Smyrna','DE',39.299,-75.60,0,1,1]
  ];
  for (const x of items) add.run(...x);
}

function ensureAdmin(){
  const email = process.env.ADMIN_EMAIL;
  const pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw) return;
  if (pw.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  if (!db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
    db.prepare("INSERT INTO users(name,email,password_hash,role,verified) VALUES(?,?,?,?,1)")
      .run('SaleSpot Admin', email, bcrypt.hashSync(pw,12), 'admin');
  }
}

function parseCookies(req){
  return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(s=>{const i=s.indexOf('=');return [decodeURIComponent(s.slice(0,i)),decodeURIComponent(s.slice(i+1))]}));
}
function auth(req,res,next){
  try {
    const token = parseCookies(req).salespot_token || (req.headers.authorization||'').replace(/^Bearer\s+/,'');
    if(!token) return res.status(401).json({error:'Sign in required'});
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({error:'Invalid or expired session'}); }
}
function optionalAuth(req,res,next){
  try { const t=parseCookies(req).salespot_token; if(t) req.user=jwt.verify(t,JWT_SECRET); } catch {} next();
}
function adminOnly(req,res,next){ if(req.user?.role!=='admin') return res.status(403).json({error:'Admin only'}); next(); }
function publicUser(id){
  return db.prepare(`SELECT u.id,u.name,u.email,u.role,u.avatar_url,u.verified,u.created_at,p.display_name,p.bio,p.phone,p.city,p.state,p.rating,p.sales_count FROM users u LEFT JOIN seller_profiles p ON p.user_id=u.id WHERE u.id=?`).get(id);
}
function serializeListing(row){
  if(!row) return null;
  const images = db.prepare('SELECT url FROM listing_images WHERE listing_id=? ORDER BY sort_order,id').all(row.id).map(x=>x.url);
  const seller = db.prepare(`SELECT u.id,u.name,u.verified,p.display_name,p.rating,p.sales_count,p.city,p.state FROM users u LEFT JOIN seller_profiles p ON p.user_id=u.id WHERE u.id=?`).get(row.seller_id);
  return {...row,images,seller};
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server,{cors:{origin:false}});
app.set('trust proxy',1);
app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],imgSrc:["'self'","data:","blob:","https://*.tile.openstreetmap.org"],styleSrc:["'self'","'unsafe-inline'","https://unpkg.com"],scriptSrc:["'self'","'unsafe-inline'","https://unpkg.com"],connectSrc:["'self'","ws:","wss:"],fontSrc:["'self'","data:"]}}}));
app.use(rateLimit({windowMs:60_000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}));

// Stripe webhook must receive raw bytes before JSON parsing.
app.post('/api/payments/webhook', express.raw({type:'application/json'}), (req,res)=>{
  if(!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe not configured');
  let event;
  try { event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET); }
  catch(e){ return res.status(400).send(`Webhook error: ${e.message}`); }
  if(event.type==='checkout.session.completed'){
    const s=event.data.object; const orderId=Number(s.metadata?.order_id);
    if(orderId){
      const order=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
      if(order){
        db.prepare("UPDATE orders SET status='paid', stripe_session_id=? WHERE id=?").run(s.id,orderId);
        db.prepare("UPDATE listings SET status='sold' WHERE id=?").run(order.listing_id);
        io.emit('listing:sold',{listingId:order.listing_id});
      }
    }
  }
  res.json({received:true});
});

app.use(express.json({limit:'2mb'}));
app.use(express.urlencoded({extended:true}));

const uploadDir=path.join(__dirname,'public','uploads');
fs.mkdirSync(uploadDir,{recursive:true});
const upload=multer({storage:multer.diskStorage({destination:uploadDir,filename:(req,file,cb)=>cb(null,`${Date.now()}-${crypto.randomBytes(5).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)}),limits:{fileSize:8*1024*1024,files:8},fileFilter:(req,file,cb)=>cb(null,/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype))});

app.post('/api/auth/signup', async (req,res)=>{
  const name=cleanText(req.body.name,80), email=cleanText(req.body.email,254).toLowerCase(), password=String(req.body.password||'');
  if(!name||!validEmail(email)||password.length<8||password.length>128) return res.status(400).json({error:'Valid name, email and password (8–128 characters) are required'});
  try{
    const hash=await bcrypt.hash(password,12);
    const id=Number(db.prepare('INSERT INTO users(name,email,password_hash) VALUES(?,?,?)').run(name,email,hash).lastInsertRowid);
    db.prepare('INSERT INTO seller_profiles(user_id,display_name) VALUES(?,?)').run(id,name);
    const user=publicUser(id); const token=jwt.sign({id:user.id,role:user.role},JWT_SECRET,{expiresIn:'7d'});
    res.cookie('salespot_token',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*86400_000,path:'/'}).json({user});
  }catch(e){ res.status(409).json({error:e.message.includes('UNIQUE')?'Email already registered':'Unable to create account'}); }
});
app.post('/api/auth/login', async (req,res)=>{
  const {email,password}=req.body; const user=db.prepare('SELECT * FROM users WHERE email=?').get(String(email||'').trim().toLowerCase());
  if(!user || !(await bcrypt.compare(password||'',user.password_hash))) return res.status(401).json({error:'Incorrect email or password'});
  const token=jwt.sign({id:user.id,role:user.role},JWT_SECRET,{expiresIn:'7d'});
  res.cookie('salespot_token',token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:7*86400_000,path:'/'}).json({user:publicUser(user.id)});
});
app.post('/api/auth/logout',(req,res)=>res.clearCookie('salespot_token',{path:'/'}).json({ok:true}));
app.get('/api/me',optionalAuth,(req,res)=>res.json({user:req.user?publicUser(req.user.id):null}));
app.put('/api/me/profile',auth,(req,res)=>{
  const {display_name,bio,phone,city,state}=req.body;
  db.prepare(`INSERT INTO seller_profiles(user_id,display_name,bio,phone,city,state) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET display_name=excluded.display_name,bio=excluded.bio,phone=excluded.phone,city=excluded.city,state=excluded.state`).run(req.user.id,display_name||'',bio||'',phone||'',city||'',state||'');
  res.json({user:publicUser(req.user.id)});
});
app.get('/api/sellers/:id',(req,res)=>{const u=publicUser(Number(req.params.id)); if(!u) return res.status(404).json({error:'Seller not found'}); delete u.email; delete u.phone; res.json({seller:u,listings:db.prepare("SELECT * FROM listings WHERE seller_id=? AND status='active' ORDER BY created_at DESC").all(u.id).map(serializeListing)});});

app.get('/api/listings', optionalAuth, (req,res)=>{
  const {type,category,q,status='active'}=req.query; let sql='SELECT * FROM listings WHERE status=?'; const args=[status];
  if(type){sql+=' AND type=?';args.push(type)} if(category){sql+=' AND category=?';args.push(category)} if(q){sql+=' AND (title LIKE ? OR description LIKE ? OR category LIKE ?)'; const s=`%${q}%`;args.push(s,s,s)}
  sql+=' ORDER BY featured DESC, created_at DESC LIMIT 200'; let rows=db.prepare(sql).all(...args);
  if(req.query.lat&&req.query.lng&&req.query.radius){
    const lat=Number(req.query.lat),lng=Number(req.query.lng),r=Number(req.query.radius); const rad=x=>x*Math.PI/180;
    rows=rows.filter(x=>{if(x.latitude==null||x.longitude==null)return false; const dlat=rad(x.latitude-lat),dlng=rad(x.longitude-lng); const a=Math.sin(dlat/2)**2+Math.cos(rad(lat))*Math.cos(rad(x.latitude))*Math.sin(dlng/2)**2;return 3958.8*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))<=r;});
  }
  res.json({listings:rows.map(serializeListing)});
});
app.get('/api/listings/:id',optionalAuth,(req,res)=>{const l=serializeListing(db.prepare('SELECT * FROM listings WHERE id=?').get(Number(req.params.id))); if(!l)return res.status(404).json({error:'Listing not found'}); l.bids=db.prepare(`SELECT b.id,b.amount_cents,b.created_at,u.name bidder FROM bids b JOIN users u ON u.id=b.bidder_id WHERE b.listing_id=? ORDER BY b.amount_cents DESC,b.created_at ASC LIMIT 50`).all(l.id); if(req.user)l.watched=!!db.prepare('SELECT 1 FROM watchlist WHERE user_id=? AND listing_id=?').get(req.user.id,l.id); res.json({listing:l});});
app.post('/api/listings',auth,upload.array('images',8),(req,res)=>{
  const b=req.body; b.title=cleanText(b.title,140); b.description=cleanText(b.description,5000); b.category=cleanText(b.category,80)||'Other';
  if(!b.title||!['auction','marketplace','yard_sale','estate_sale'].includes(b.type)) return res.status(400).json({error:'Valid type and title required'});
  const cents=v=>{ if(v===''||v==null)return null; const n=Number(v); return Number.isFinite(n)&&n>=0?Math.round(n*100):NaN; };
  const price=cents(b.price), startBid=cents(b.start_bid), reserve=cents(b.reserve), increment=cents(b.bid_increment);
  if([price,startBid,reserve,increment].some(Number.isNaN)) return res.status(400).json({error:'Prices and bids must be valid non-negative numbers'});
  if(b.type==='marketplace' && (!price || price<1)) return res.status(400).json({error:'Marketplace listings require a price'});
  if(b.type==='auction' && (!startBid || startBid<1)) return res.status(400).json({error:'Auctions require a starting bid'});
  if(b.type==='auction' && (!b.ends_at || new Date(b.ends_at).getTime()<=Date.now())) return res.status(400).json({error:'Auction end time must be in the future'});
  const result=db.prepare(`INSERT INTO listings(seller_id,type,title,description,category,price_cents,start_bid_cents,current_bid_cents,reserve_cents,bid_increment_cents,starts_at,ends_at,event_date,event_time,address,city,state,latitude,longitude,shipping,local_pickup,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active')`).run(req.user.id,b.type,b.title,b.description,b.category,price,startBid,startBid,reserve,increment||100,b.starts_at||null,b.ends_at||null,b.event_date||null,b.event_time||null,b.address||null,b.city||null,b.state||null,b.latitude?Number(b.latitude):null,b.longitude?Number(b.longitude):null,b.shipping==='true'||b.shipping==='on'?1:0,b.local_pickup==='false'?0:1);
  const id=Number(result.lastInsertRowid); const ins=db.prepare('INSERT INTO listing_images(listing_id,url,sort_order) VALUES(?,?,?)'); (req.files||[]).forEach((f,i)=>ins.run(id,`/uploads/${f.filename}`,i));
  io.emit('listing:new',{listing:serializeListing(db.prepare('SELECT * FROM listings WHERE id=?').get(id))}); res.status(201).json({listing:serializeListing(db.prepare('SELECT * FROM listings WHERE id=?').get(id))});
});
app.post('/api/listings/:id/watch',auth,(req,res)=>{db.prepare('INSERT OR IGNORE INTO watchlist(user_id,listing_id) VALUES(?,?)').run(req.user.id,Number(req.params.id));res.json({watched:true});});
app.delete('/api/listings/:id/watch',auth,(req,res)=>{db.prepare('DELETE FROM watchlist WHERE user_id=? AND listing_id=?').run(req.user.id,Number(req.params.id));res.json({watched:false});});
app.get('/api/watchlist',auth,(req,res)=>res.json({listings:db.prepare('SELECT l.* FROM listings l JOIN watchlist w ON w.listing_id=l.id WHERE w.user_id=? ORDER BY w.created_at DESC').all(req.user.id).map(serializeListing)}));

app.post('/api/listings/:id/bids',auth,(req,res)=>{
  const id=Number(req.params.id), amount=Math.round(Number(req.body.amount)*100); if(!Number.isFinite(amount)) return res.status(400).json({error:'Enter a valid bid'});
  db.exec('BEGIN IMMEDIATE');
  try{
    const l=db.prepare('SELECT * FROM listings WHERE id=?').get(id); if(!l||l.type!=='auction'||l.status!=='active') throw new Error('Auction is not active');
    if(l.ends_at && new Date(l.ends_at).getTime()<=Date.now()) throw new Error('Auction has ended');
    if(l.seller_id===req.user.id) throw new Error('You cannot bid on your own listing');
    const minimum=(l.current_bid_cents||l.start_bid_cents||0)+(l.bid_increment_cents||100); if(amount<minimum) throw new Error(`Minimum bid is $${(minimum/100).toFixed(2)}`);
    db.prepare('INSERT INTO bids(listing_id,bidder_id,amount_cents) VALUES(?,?,?)').run(id,req.user.id,amount); db.prepare('UPDATE listings SET current_bid_cents=? WHERE id=?').run(amount,id); db.exec('COMMIT');
    const payload={listingId:id,amount_cents:amount,bidder:publicUser(req.user.id).name,created_at:new Date().toISOString()}; io.to(`listing:${id}`).emit('bid:new',payload); res.json(payload);
  }catch(e){db.exec('ROLLBACK');res.status(400).json({error:e.message});}
});

app.get('/api/messages',auth,(req,res)=>{
  const msgs=db.prepare(`SELECT m.*,su.name sender_name,ru.name receiver_name,l.title listing_title FROM messages m JOIN users su ON su.id=m.sender_id JOIN users ru ON ru.id=m.receiver_id LEFT JOIN listings l ON l.id=m.listing_id WHERE m.sender_id=? OR m.receiver_id=? ORDER BY m.created_at DESC LIMIT 300`).all(req.user.id,req.user.id); res.json({messages:msgs});
});
app.post('/api/messages',auth,(req,res)=>{
  const receiver=Number(req.body.receiver_id),body=String(req.body.body||'').trim(); if(!receiver||!body) return res.status(400).json({error:'Recipient and message required'}); if(receiver===req.user.id)return res.status(400).json({error:'You cannot message yourself'}); if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(receiver))return res.status(404).json({error:'Recipient not found'}); if(body.length>2000)return res.status(400).json({error:'Message is too long'});
  const id=Number(db.prepare('INSERT INTO messages(sender_id,receiver_id,listing_id,body) VALUES(?,?,?,?)').run(req.user.id,receiver,req.body.listing_id?Number(req.body.listing_id):null,body).lastInsertRowid); const m=db.prepare('SELECT * FROM messages WHERE id=?').get(id); io.to(`user:${receiver}`).emit('message:new',m); res.status(201).json({message:m});
});

app.post('/api/payments/checkout',auth,async(req,res)=>{
  if(!stripe) return res.status(503).json({error:'Stripe is not configured yet. Add STRIPE_SECRET_KEY to .env.'});
  const listing=db.prepare("SELECT * FROM listings WHERE id=? AND type='marketplace' AND status='active'").get(Number(req.body.listing_id)); if(!listing||!listing.price_cents)return res.status(404).json({error:'Buy-now listing not available'}); if(listing.seller_id===req.user.id)return res.status(400).json({error:'You cannot buy your own listing'});
  const orderId=Number(db.prepare('INSERT INTO orders(listing_id,buyer_id,seller_id,amount_cents) VALUES(?,?,?,?)').run(listing.id,req.user.id,listing.seller_id,listing.price_cents).lastInsertRowid);
  const session=await stripe.checkout.sessions.create({mode:'payment',line_items:[{price_data:{currency:'usd',unit_amount:listing.price_cents,product_data:{name:listing.title}},quantity:1}],success_url:`${APP_URL}/?payment=success&order=${orderId}`,cancel_url:`${APP_URL}/?payment=cancelled`,metadata:{order_id:String(orderId),listing_id:String(listing.id)}});
  db.prepare('UPDATE orders SET stripe_session_id=? WHERE id=?').run(session.id,orderId); res.json({url:session.url});
});

app.get('/api/admin/summary',auth,adminOnly,(req,res)=>{
  res.json({users:db.prepare('SELECT COUNT(*) c FROM users').get().c,listings:db.prepare('SELECT COUNT(*) c FROM listings').get().c,active:db.prepare("SELECT COUNT(*) c FROM listings WHERE status='active'").get().c,bids:db.prepare('SELECT COUNT(*) c FROM bids').get().c,messages:db.prepare('SELECT COUNT(*) c FROM messages').get().c,orders:db.prepare('SELECT COUNT(*) c FROM orders').get().c,gross_cents:db.prepare("SELECT COALESCE(SUM(amount_cents),0) c FROM orders WHERE status='paid'").get().c});
});
app.get('/api/admin/users',auth,adminOnly,(req,res)=>res.json({users:db.prepare('SELECT id,name,email,role,verified,created_at FROM users ORDER BY created_at DESC LIMIT 500').all()}));
app.get('/api/admin/listings',auth,adminOnly,(req,res)=>res.json({listings:db.prepare('SELECT * FROM listings ORDER BY created_at DESC LIMIT 500').all().map(serializeListing)}));
app.patch('/api/admin/listings/:id',auth,adminOnly,(req,res)=>{const status=String(req.body.status||''); if(!['draft','active','sold','ended','removed'].includes(status))return res.status(400).json({error:'Invalid status'}); db.prepare('UPDATE listings SET status=? WHERE id=?').run(status,Number(req.params.id));res.json({ok:true});});

io.use((socket,next)=>{
  try { const cookie=socket.handshake.headers.cookie||''; const m=cookie.match(/(?:^|;\s*)salespot_token=([^;]+)/); if(m)socket.user=jwt.verify(decodeURIComponent(m[1]),JWT_SECRET); next(); } catch { next(); }
});
io.on('connection',socket=>{
  if(socket.user)socket.join(`user:${socket.user.id}`);
  socket.on('listing:join',id=>{const n=Number(id);if(Number.isInteger(n))socket.join(`listing:${n}`)});
  socket.on('listing:leave',id=>socket.leave(`listing:${Number(id)}`));
});

app.use(express.static(path.join(__dirname,'public'),{extensions:['html']}));
app.get('/{*splat}',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
server.listen(PORT,()=>console.log(`SaleSpot running at ${APP_URL}`));
