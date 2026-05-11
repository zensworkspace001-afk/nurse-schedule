// 快速診斷：印出 NurseApp/Staff + StaffPublic + 所有 StaffPrivate/{id} 的目前內容
// 純讀取，不寫任何東西
import admin from 'firebase-admin';

if (!admin.apps.length) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      let sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
      admin.initializeApp({ credential: admin.credential.cert(sa) });
    } catch {
      // fallback to three-piece
    }
  }
  if (!admin.apps.length) {
    let pk = process.env.FIREBASE_PRIVATE_KEY;
    if (pk) pk = pk.replace(/^"|"$/g, '').replace(/\\n/g, '\n');
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: pk,
      }),
    });
  }
}

const db = admin.firestore();

const [staffSnap, publicSnap, privateColl] = await Promise.all([
  db.doc('NurseApp/Staff').get(),
  db.doc('NurseApp/StaffPublic').get(),
  db.collection('StaffPrivate').get(),
]);

const staff = staffSnap.exists ? staffSnap.data() : null;
const pub = publicSnap.exists ? publicSnap.data() : null;

console.log('═'.repeat(60));
console.log('📁 NurseApp/Staff');
console.log('═'.repeat(60));
if (!staff) {
  console.log('  ❌ doc 不存在');
} else {
  console.log(`  staffData 筆數: ${staff.staffData?.length ?? 0}`);
  console.log(`  healthStats 筆數: ${staff.healthStats?.length ?? 0}`);
  if (staff.staffData?.length) {
    console.log('  前 5 筆 staff_id:', staff.staffData.slice(0, 5).map(s => s.staff_id).join(', '));
  }
}

console.log('═'.repeat(60));
console.log('📁 NurseApp/StaffPublic');
console.log('═'.repeat(60));
if (!pub) {
  console.log('  ❌ doc 不存在');
} else {
  console.log(`  staffData 筆數: ${pub.staffData?.length ?? 0}`);
  if (pub.staffData?.length) {
    console.log('  前 5 筆 staff_id:', pub.staffData.slice(0, 5).map(s => s.staff_id).join(', '));
  }
}

console.log('═'.repeat(60));
console.log('📁 StaffPrivate/* (collection)');
console.log('═'.repeat(60));
console.log(`  總 doc 數: ${privateColl.size}`);
if (privateColl.size > 0) {
  console.log('  doc IDs:', privateColl.docs.slice(0, 10).map(d => d.id).join(', '),
    privateColl.size > 10 ? `… (+${privateColl.size - 10} more)` : '');
}

console.log('═'.repeat(60));

process.exit(0);
