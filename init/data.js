//IMAGES DATA

const sampleListings = [
  // ==================== INDIA — MUMBAI ====================
  {
    title: "Sea-View Luxury Suite, Marine Drive",
    description: "Wake up to breathtaking views of the Arabian Sea from this premium suite on Mumbai's iconic Marine Drive. Walking distance from Nariman Point and Gateway of India.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&w=800&q=60" },
    price: 8500, location: "Mumbai", country: "India",
  },
  {
    title: "Heritage Boutique Stay, Colaba",
    description: "Experience Mumbai's colonial charm in this beautifully restored boutique property near the Gateway of India. Walking distance to Leopold Cafe and Taj Hotel.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1512917774080-9991f1c4c750?auto=format&fit=crop&w=800&q=60" },
    price: 6200, location: "Mumbai", country: "India",
  },
  {
    title: "Modern Studio, Bandra West",
    description: "Stylish, contemporary studio apartment in the heart of Bandra — Mumbai's hippest neighbourhood. Steps from bandstand, cafes, and nightlife.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1522708323590-d24dbb6b0267?auto=format&fit=crop&w=800&q=60" },
    price: 4500, location: "Mumbai", country: "India",
  },

  // ==================== INDIA — DELHI ====================
  {
    title: "Luxe Hotel Suite, Connaught Place",
    description: "Stay at the heart of New Delhi in this premium suite at Connaught Place. Close to Janpath market, Rajiv Chowk metro, and India Gate.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1551882547-ff40c63fe5fa?auto=format&fit=crop&w=800&q=60" },
    price: 7200, location: "Delhi", country: "India",
  },
  {
    title: "Heritage Haveli, Lodi Colony",
    description: "A reimagined heritage bungalow nestled in Delhi's leafy Lodi Colony area. Minutes from Lodi Garden, Khan Market, and top embassies.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1564501049412-61c2a3083791?auto=format&fit=crop&w=800&q=60" },
    price: 5800, location: "Delhi", country: "India",
  },
  {
    title: "Budget Comfort Inn, Paharganj",
    description: "Clean, comfortable and centrally located near New Delhi Railway Station in Paharganj. Perfect for backpackers and budget travellers.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1631049307264-da0ec9d70304?auto=format&fit=crop&w=800&q=60" },
    price: 1800, location: "Delhi", country: "India",
  },

  // ==================== INDIA — NOIDA ====================
  {
    title: "Executive Apartment, Sector 18",
    description: "Spacious executive apartment in Noida's commercial hub — Sector 18. Perfect for corporate travelers with fast WiFi, pool access and gym.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1502672260266-1c1ef2d93688?auto=format&fit=crop&w=800&q=60" },
    price: 3500, location: "Noida", country: "India",
  },
  {
    title: "Cozy Studio, Sector 62",
    description: "Fully furnished studio in IT hub Sector 62, Noida. Great connectivity to metro and close to offices, malls, and restaurants.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1540518614846-7eded433c457?auto=format&fit=crop&w=800&q=60" },
    price: 2200, location: "Noida", country: "India",
  },

  // ==================== INDIA — GOA ====================
  {
    title: "Beachfront Shack Villa, Calangute",
    description: "Escape to this gorgeous beach villa in Calangute, Goa. Steps from the beach, surrounded by coconut palms, with a private pool and bar.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=800&q=60" },
    price: 9500, location: "Goa", country: "India",
  },
  {
    title: "Luxury Resort Villa, Panjim",
    description: "Experience Portuguese-influenced Goan architecture in this luxury resort villa near Panjim. Private pool, lush gardens, and world-class hospitality.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1571003123894-1f0594d2b5d9?auto=format&fit=crop&w=800&q=60" },
    price: 12000, location: "Goa", country: "India",
  },
  {
    title: "Bungalow on Anjuna Beach",
    description: "Rustic yet comfortable bungalow right on Anjuna Beach. Wake up to the sound of waves, enjoy nightly bonfires and flea market shopping.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?auto=format&fit=crop&w=800&q=60" },
    price: 5500, location: "Goa", country: "India",
  },

  // ==================== INDIA — JAIPUR ====================
  {
    title: "Palace Suite, City Palace Area",
    description: "Live like royalty in this opulent palace suite in Jaipur's Pink City. Walking distance from City Palace, Hawa Mahal, and Jantar Mantar.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1599661046289-e31897846e41?auto=format&fit=crop&w=800&q=60" },
    price: 11000, location: "Jaipur", country: "India",
  },
  {
    title: "Heritage Haveli, Old City",
    description: "Stay in a 19th-century haveli in Jaipur's Old City. Intricately carved sandstone walls, rooftop restaurant, and cultural performances every evening.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1586375300773-8384e3e4916f?auto=format&fit=crop&w=800&q=60" },
    price: 7500, location: "Jaipur", country: "India",
  },

  // ==================== INDIA — BANGALORE ====================
  {
    title: "Tech Park Serviced Apartment, Whitefield",
    description: "Modern, fully furnished serviced apartment in Whitefield — Bangalore's tech corridor. Minutes from ITPL, Phoenix Mall, and Embassy Golf Links.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1493809842364-78817add7ffb?auto=format&fit=crop&w=800&q=60" },
    price: 4200, location: "Bangalore", country: "India",
  },
  {
    title: "Boutique Stay, Indiranagar",
    description: "Charming boutique stay in Bangalore's vibrant Indiranagar. Surrounded by the best restaurants, craft breweries, and shopping streets in the city.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1522771739844-6a9f6d5f14af?auto=format&fit=crop&w=800&q=60" },
    price: 5200, location: "Bangalore", country: "India",
  },

  // ==================== INDIA — MANALI ====================
  {
    title: "Snow-View Cottage, Old Manali",
    description: "Cozy mountain cottage in Old Manali with panoramic views of snow-capped Himalayas. Wood-burning fireplace, trekking routes at your doorstep.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?auto=format&fit=crop&w=800&q=60" },
    price: 3800, location: "Manali", country: "India",
  },
  {
    title: "Luxury Himalayan Resort, Solang Valley",
    description: "Premium mountain resort in Solang Valley near Manali. Ski-in access, heated indoor pool, and gourmet dining with Himalayan views.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1502784444187-359ac186c5bb?auto=format&fit=crop&w=800&q=60" },
    price: 14000, location: "Manali", country: "India",
  },

  // ==================== INDIA — UDAIPUR ====================
  {
    title: "Lakeside Heritage Palace, Pichola",
    description: "A stunning heritage palace on the banks of Lake Pichola in Udaipur — the City of Lakes. Boat rides, royal dining, and sunset views.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1567157577867-05ccb1388e66?auto=format&fit=crop&w=800&q=60" },
    price: 18000, location: "Udaipur", country: "India",
  },

  // ==================== INDIA — KERALA ====================
  {
    title: "Backwater Houseboat, Alleppey",
    description: "Cruise through Kerala's magical backwaters on this premium luxury houseboat. Enjoy freshly cooked Kerala cuisine, toddy, and coconut groves.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1602391833977-358a52198938?auto=format&fit=crop&w=800&q=60" },
    price: 8800, location: "Kerala", country: "India",
  },
  {
    title: "Jungle Treehouse, Munnar",
    description: "A romantic treehouse perched in the middle of Munnar's tea gardens. Wake up to mist, birdsong, and fresh mountain air.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1488462237308-ecaa28b729d7?auto=format&fit=crop&w=800&q=60" },
    price: 6500, location: "Kerala", country: "India",
  },

  // ==================== INDIA — SHIMLA ====================
  {
    title: "Colonial Cottage, The Ridge",
    description: "Charming colonial-era cottage near The Ridge in Shimla. Sweeping valley views, apple orchards, and the Mall Road at a stroll's distance.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1502784444187-359ac186c5bb?auto=format&fit=crop&w=800&q=60" },
    price: 4500, location: "Shimla", country: "India",
  },

  // ==================== INDIA — RISHIKESH ====================
  {
    title: "Riverside Glamping Dome, Rishikesh",
    description: "Unique igloo-style dome tent right on the banks of the Ganges in Rishikesh. Yoga sessions, white-water rafting and bungee jumping nearby.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1504280390367-361c6d9f38f4?auto=format&fit=crop&w=800&q=60" },
    price: 5200, location: "Rishikesh", country: "India",
  },

  // ==================== INDIA — AGRA ====================
  {
    title: "Taj View Heritage Room, Agra",
    description: "Unobstructed views of the Taj Mahal from your rooftop terrace. Located just 500m from the East Gate. Watch the Taj change colors at sunrise.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1524492412937-b28074a5d7da?auto=format&fit=crop&w=800&q=60" },
    price: 7800, location: "Agra", country: "India",
  },

  // ==================== INDIA — VARANASI ====================
  {
    title: "Ganges Ghat Heritage Bungalow",
    description: "Historic bungalow overlooking the Ganges ghats in Varanasi. Watch the evening Ganga Aarti from your private balcony. Spiritual, serene, and unforgettable.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1561361058-c24cecae35ca?auto=format&fit=crop&w=800&q=60" },
    price: 5500, location: "Varanasi", country: "India",
  },

  // ==================== INDIA — KOLKATA ====================
  {
    title: "Colonial Suite, Park Street",
    description: "Elegant colonial suite in Kolkata's cosmopolitan Park Street. Experience the city of joy's art, culture, food and festivity at its finest.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1564501049412-61c2a3083791?auto=format&fit=crop&w=800&q=60" },
    price: 5000, location: "Kolkata", country: "India",
  },

  // ==================== INDIA — HYDERABAD ====================
  {
    title: "Grand Residency, Banjara Hills",
    description: "Luxury 5-star residency in Hyderabad's upmarket Banjara Hills. Rooftop infinity pool, award-winning biryani restaurant, and city views.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?auto=format&fit=crop&w=800&q=60" },
    price: 9200, location: "Hyderabad", country: "India",
  },

  // ==================== INDIA — DARJEELING ====================
  {
    title: "Tea Estate Bungalow, Darjeeling",
    description: "Stay in a vintage planter's bungalow surrounded by Darjeeling's world-famous tea gardens. Watch sunrise over Kanchenjunga and sip first-flush teas.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1460533893735-45cea2212645?auto=format&fit=crop&w=800&q=60" },
    price: 6800, location: "Darjeeling", country: "India",
  },

  // ==================== INDIA — PUNE ====================
  {
    title: "Modern Apartment, Koregaon Park",
    description: "Chic and modern apartment in Pune's trendiest neighborhood — Koregaon Park. Steps from German Bakery, Osho Ashram, and the best restaurants in the city.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1493809842364-78817add7ffb?auto=format&fit=crop&w=800&q=60" },
    price: 3800, location: "Pune", country: "India",
  },

  // ==================== INDIA — CHENNAI ====================
  {
    title: "Beachside Suite, Besant Nagar",
    description: "Elegant suite near Besant Nagar beach in Chennai. Minutes from Elliots Beach, Murugan Idli Shop, and the historic French Quarter of Pondicherry is just 3 hours away.",
    image: { filename: "listingimage", url: "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?auto=format&fit=crop&w=800&q=60" },
    price: 4600, location: "Chennai", country: "India",
  },
];

module.exports = { data: sampleListings };
