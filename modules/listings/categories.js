// Listing categories: one list for the model, validation, and the category
// menus. Menus show only categories that currently have stays (the others
// used to lead to "No stays found").
const CATEGORIES = [
  { name: "Trending", label: "Trending", icon: "fa-fire", color: "#B26335" },
  { name: "Rooms", label: "Rooms", icon: "fa-bed", color: "#7A3A14" },
  { name: "Iconic Cities", label: "Iconic Cities", icon: "fa-mountain-city", color: "#3B3A1E" },
  { name: "Mountains", label: "Mountains", icon: "fa-mountain", color: "#4F4E28" },
  { name: "Castles", label: "Castles", icon: "fa-chess-rook", color: "#5D2C0C" },
  { name: "Amazing Pools", label: "Pools", icon: "fa-person-swimming", color: "#2E6E65" },
  { name: "Camping", label: "Camping", icon: "fa-campground", color: "#3B5C2A" },
  { name: "Farms", label: "Farms", icon: "fa-seedling", color: "#6B5220" },
  { name: "Arctic", label: "Arctic", icon: "fa-snowflake", color: "#3A5E7A" },
  { name: "Domes", label: "Domes", icon: "fa-igloo", color: "#5E3E2C" },
  { name: "Boats", label: "Boats", icon: "fa-sailboat", color: "#2A4E78" },
];

const CATEGORY_NAMES = CATEGORIES.map((c) => c.name);

module.exports = { CATEGORIES, CATEGORY_NAMES };
