// Amenities a host can tick for a listing. The listing page shows only what
// the host selected (it used to show the same eight for every stay).
const AMENITIES = [
  { key: "wifi", label: "Free WiFi", icon: "fa-wifi" },
  { key: "ac", label: "Air conditioning", icon: "fa-snowflake" },
  { key: "kitchen", label: "Kitchen", icon: "fa-kitchen-set" },
  { key: "parking", label: "Free parking", icon: "fa-car" },
  { key: "tv", label: "TV", icon: "fa-tv" },
  { key: "workspace", label: "Workspace", icon: "fa-laptop" },
  { key: "washer", label: "Washing machine", icon: "fa-shirt" },
  { key: "pool", label: "Pool", icon: "fa-water-ladder" },
  { key: "gym", label: "Gym", icon: "fa-dumbbell" },
  { key: "breakfast", label: "Breakfast included", icon: "fa-mug-hot" },
  { key: "security", label: "24/7 security", icon: "fa-shield-halved" },
  { key: "pets", label: "Pets allowed", icon: "fa-paw" },
];

const AMENITY_KEYS = AMENITIES.map((a) => a.key);

module.exports = { AMENITIES, AMENITY_KEYS };
