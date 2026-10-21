mapboxgl.accessToken = mapToken;

// Built with textContent (not setHTML) so a title can never inject markup.
function buildPopup(title) {
  const wrap = document.createElement("div");
  const h4 = document.createElement("h4");
  h4.textContent = title;
  const p = document.createElement("p");
  p.textContent = "Exact Location will be provided after booking";
  wrap.append(h4, p);
  return wrap;
}
const map = new mapboxgl.Map({
  container: "map", // container ID
  style: "mapbox://styles/mapbox/streets-v12",
  center: listing.geometry.coordinates, // starting position [lng, lat]. Note that lat must be set between -90 and 90
  zoom: 9, // starting zoom
});

// console.log(coordinates);
const marker = new mapboxgl.Marker({ color: "red" })
  .setLngLat(listing.geometry.coordinates) //Listing.geometry,coordinates
  .setPopup(
    new mapboxgl.Popup({ offset: 25 })
      .setDOMContent(buildPopup(listing.title)),
  )
  .addTo(map);

