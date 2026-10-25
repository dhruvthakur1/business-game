const P = (file: string) => `/art/products/${file}.svg`;

/** Showroom gallery used by the product art catalog page. */
export const GALLERY = {
  luxury: [
    { name: 'Silver chain', price: '2,000 CR', art: P('silver-chain') },
    { name: 'Designer bag', price: '25,000 CR', art: P('handbag') },
    { name: 'Diamond ring', price: '200,000 CR', art: P('diamond-ring') },
    { name: 'Named gem', price: '10M+ CR', art: P('named-gem') },
    { name: 'Streetwear', price: '300 CR', art: P('streetwear-tee') },
    { name: 'Designer sneakers', price: '5,000 CR', art: P('sneakers') },
    { name: 'Gala gown', price: '250,000 CR', art: P('gala-gown') },
  ],
  big: [
    { name: 'Superyacht', price: '150M CR', art: P('superyacht') },
    { name: 'Private jet', price: '300M CR', art: P('private-jet') },
    { name: 'Smartphone', price: '230 wholesale', art: P('smartphone') },
    { name: 'Laptop', price: '650 wholesale', art: P('laptop') },
  ],
};
