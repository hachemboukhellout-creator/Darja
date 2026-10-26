const people = [
  ['Amine Benali', 'Alger'], ['Lina Boudiaf', 'Oran'], ['Yacine Meziane', 'Constantine'],
  ['Sarah Ait Ahmed', 'Tizi Ouzou'], ['Mehdi Bouzid', 'Sétif'], ['Nour Belkacem', 'Blida'],
  ['Rayan Hamidi', 'Béjaïa'], ['Inès Merabet', 'Annaba'], ['Sofiane Rahmani', 'Batna'],
  ['Meriem Saidi', 'Boumerdès'], ['Anis Khelifi', 'Tlemcen'], ['Yasmine Boualem', 'Tipaza'],
  ['Imane Haddad', 'Alger'], ['Walid Ziani', 'Oran'], ['Kenza Amrani', 'Constantine'],
  ['Adam Touati', 'Sétif'], ['Aya Mansouri', 'Béjaïa'], ['Ilyes Cherif', 'Blida'],
  ['Rania Brahimi', 'Alger'], ['Youcef Kadri', 'Oran'], ['Selma Djemai', 'Annaba'],
  ['Nabil Abbassi', 'Tizi Ouzou'], ['Dounia Bakhti', 'Tipaza'], ['Karim Belaid', 'Alger'],
];
const products = [
  ['Everyday linen tote', 2900], ['Ceramic coffee set', 5800], ['Minimal desk lamp', 6900],
  ['Essential cotton hoodie', 4900], ['Everyday crossbody bag', 4200], ['Wireless headphones', 7900],
  ['Botanical skincare set', 6500], ['Classic leather wallet', 3500], ['Ribbed glass set', 3200],
  ['Signature scented candle', 2400], ['Premium prayer mat', 4500], ['Stainless steel bottle', 2800],
];
const statuses = ['delivered', 'delivered', 'pending', 'confirmed', 'delivered', 'shipped', 'delivered', 'returned', 'pending', 'delivered', 'shipped', 'cancelled'];
const carriers = ['Yalidine', 'ZR Express', 'Maystro', 'Guepex'];

export function seedOrders(db, userId, now = new Date()) {
  const insert = db.prepare(`INSERT INTO orders (user_id,id,customer,phone,email,wilaya,address,product,quantity,amount,status,carrier,created_at,updated_at,events) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < 126; i++) {
    const [customer, wilaya] = people[i % people.length];
    const [product, price] = products[i % products.length];
    const quantity = i % 11 === 0 ? 2 : 1;
    // Recent orders stay operational; completed orders provide a realistic history.
    const daysAgo = i < 10 ? 0 : i < 65 ? Math.floor((i - 10) / 2) + 1 : 30 + (i - 65);
    const created = new Date(now.getTime() - daysAgo * 86400000 - (i % 9) * 42 * 60000);
    const status = i < 10 ? ['pending', 'confirmed', 'shipped', 'pending', 'delivered', 'pending', 'confirmed', 'shipped', 'returned', 'pending'][i] : statuses[i % statuses.length];
    const events = [{ status: 'pending', at: created.toISOString() }];
    const chain = status === 'pending' ? [] : status === 'cancelled' ? ['cancelled'] : status === 'confirmed' ? ['confirmed'] : status === 'shipped' ? ['confirmed', 'shipped'] : ['confirmed', 'shipped', status];
    chain.forEach((value, j) => events.push({ status: value, at: new Date(Math.min(now.getTime(), created.getTime() + (j + 1) * 1800000)).toISOString() }));
    insert.run(userId, `DZ-${String(2048 - i)}`, customer, `+21355${String(1000000 + i % people.length).slice(-7)}`, `${customer.toLowerCase().split(' ')[0]}@example.com`, wilaya, `${12 + i % 30} Rue des Oliviers, ${wilaya}`, product, quantity, price * quantity * 100, status, carriers[i % carriers.length], created.toISOString(), events.at(-1).at, JSON.stringify(events));
  }
}
