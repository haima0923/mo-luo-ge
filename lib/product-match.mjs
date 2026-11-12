// 检索时的类目参考，不回写原始货物、HS编码或价格。
// 分类只读取产品名称和显式别名；材质、地址、姓名及整段原文不能推导类目。
const category=(id,name,parent,aliases=[])=>({id,name,parent,aliases:[name,...aliases]});
export const PRODUCT_CATEGORIES=[
  category('hardware','五金',null,['五金产品','五金制品','hardware','quincaillerie']),
  category('plumbing','卫浴五金','hardware',['水暖五金','卫浴配件','水暖配件','sanitary fittings','plumbing hardware','robinetterie']),
  category('locks','锁具','hardware',['锁类','locks','serrurerie']),
  category('fasteners','紧固件','hardware',['螺丝类','fasteners','visserie']),
  category('hooks','挂钩五金','hardware',['挂钩配件']),
  category('wire','金属丝线','hardware',['钢丝类','metal wire']),
  category('metal-parts','金属配件','hardware',['箱包五金','五金配件','metal fittings']),
  category('machinery','机械设备',null,['机械','机器设备','machinery','industrial equipment','machines industrielles']),
  category('packing-machines','包装灌装机械','machinery',['包装机械','灌装设备','packaging machinery','filling equipment']),
  category('food-machines','食品机械','machinery',['食品加工设备','food machinery']),
  category('engineering-machines','工程机械','machinery',['工程设备','construction machinery']),
  category('processing-machines','工业加工机械','machinery',['加工设备','机床','machine tools']),
  category('electromechanical','机电设备','machinery',['机电产品','electromechanical equipment']),
  category('electronics','电子数码',null,['电子产品','数码产品','electronics','produits électroniques']),
  category('audio','耳机音响','electronics',['音频设备','audio equipment']),
  category('car-electronics','车载电子','electronics',['汽车电子','car electronics']),
  category('computer-equipment','电脑及显示设备','electronics',['电脑设备','显示设备','computer equipment']),
  category('phone-accessories','手机配件','electronics',['mobile accessories','accessoires téléphone']),
  category('appliances','家用电器',null,['小家电','家电','home appliances','électroménager']),
  category('beauty-appliances','美发美容电器','appliances',['美容仪器','美发电器','hair appliances']),
  category('furniture','家具',null,['家居家具','furniture','meubles','mobilier']),
  category('seating','沙发座椅','furniture',['seating']),
  category('storage-furniture','柜类家具','furniture',['柜子类','storage furniture']),
  category('tables-beds','桌床家具','furniture'),
  category('textiles','纺织品',null,['家纺服装','textiles']),
  category('clothing','服装','textiles',['衣服','成衣','服饰','clothing','garments','vêtements','habillement']),
  category('home-textiles','家纺','textiles',['家用纺织品','home textiles']),
  category('fabrics','面料','textiles',['布料','fabrics','tissus']),
  category('shoes','鞋靴',null,['鞋子','鞋类','鞋类产品','footwear','shoes','chaussures']),
  category('bags','箱包',null,['包袋','bags','bagages','sacs']),
  category('packaging','包装材料',null,['包装用品','packaging materials','emballages']),
  category('paper-packaging','纸包装','packaging',['纸品包装']),
  category('plastic-packaging','塑料包装','packaging'),
  category('kitchenware','厨具餐具',null,['厨具','餐具','厨房用品','kitchenware','tableware','vaisselle']),
  category('drinkware','杯壶器皿','kitchenware',['杯具','drinkware']),
  category('lighting','灯具',null,['灯饰','照明产品','lighting','luminaires']),
  category('building','建材装修',null,['建材','装修材料','building materials','matériaux de construction']),
  category('decor','家居装饰',null,['装饰品','home decor','décoration']),
  category('sports','运动户外',null,['体育用品','户外用品','sports goods','outdoor equipment']),
  category('toys','玩具',null,['儿童玩具','toys','jouets']),
  category('auto-parts','汽车配件',null,['汽配','汽车零配件','auto parts','pièces auto']),
  category('printing','打印设备及耗材',null,['3d打印耗材','打印耗材','打印设备','printing supplies']),
];
const concept=(id,name,categoryId,aliases=[])=>({id,name,categoryId,aliases:[name,...aliases]});
const CONCEPTS=[
  concept('tap','水龙头','plumbing',['水笼头','冷热水龙头','faucet','faucets','tap','taps','mixer tap','robinet','robinets','mitigeur','حنفية']),
  concept('shower','花洒','plumbing',['淋浴喷头','淋浴花洒','淋浴器','shower head','showerhead','pommeau de douche','douchette']),
  concept('valve','阀门','plumbing',['角阀','球阀','燃气阀','水阀','valve','valves','vanne','vannes']),
  concept('drain','地漏','plumbing',['下水器','floor drain','drain de sol','siphon']),
  concept('bath-fittings','卫浴五金','plumbing',['浴室挂件','毛巾架','bathroom fittings']),
  concept('door-lock','门锁','locks',['智能门锁','电子门锁','smart door lock','door lock','serrure','serrures']),
  concept('padlock','挂锁','locks',['安全挂锁','padlock','cadenas']),
  concept('key','钥匙','locks',['keys']),
  concept('screw','螺丝','fasteners',['螺钉','screw','screws','vis']),
  concept('bolt','螺栓','fasteners',['bolt','bolts','boulon']),
  concept('nut','螺母','fasteners',['nut','nuts','écrou']),
  concept('hook','挂钩','hooks',['板挂钩','pegboard hook','hook','hooks','crochet']),
  concept('wire','铁丝','wire',['镀锌丝','镀锌铁丝','钢丝','刀片刺绳','刺绳','iron wire','steel wire','barbed wire']),
  concept('luggage-parts','箱包配件','metal-parts',['铁制箱包配件','luggage fittings']),
  concept('tin','铁盒','metal-parts',['金属盒','tin box','metal box']),
  concept('filling','灌装机','packing-machines',['灌装级','加注机','蜂蜜灌装机','filling machine','remplisseuse']),
  concept('packing','包装机','packing-machines',['包装设备','packaging machine','packing machine']),
  concept('die-cutting','模切机','processing-machines',['数码模切机','die cutting machine']),
  concept('sewing','缝纫机','processing-machines',['工业缝纫机','sewing machine','machine à coudre']),
  concept('laser','激光打标机','processing-machines',['光纤激光打标机','laser marking machine']),
  concept('boring-welding','镗焊机','processing-machines',['boring welding machine']),
  concept('molding','注塑机','processing-machines',['injection molding machine']),
  concept('shredder','撕碎机','processing-machines',['shredder']),
  concept('hat-machine','制帽机','processing-machines',['整烫机','hat making machine']),
  concept('forklift','叉车','engineering-machines',['电动叉车','forklift','chariot élévateur']),
  concept('drilling','钻机','engineering-machines',['水井钻机','drilling rig']),
  concept('grinder','研磨机','food-machines',['绞肉机','grinder','meat grinder']),
  concept('forming','成型机','processing-machines',['挤出机','炼胶机']),
  concept('industrial-service','工业维修设备','processing-machines',['贴合机','除泡机','贴合除泡一体机','手机拆屏机','拆屏机','检测设备']),
  concept('motor','电机','electromechanical',['电机组','发电机','真空泵','空压机','generator','compressor','vacuum pump']),
  concept('food-processing','食品加工机','food-machines',['面皮制作机器','开酥机','糖衣机','华夫饼机','榨汁机','waffle maker','juicer']),
  concept('headphones','耳机','audio',['蓝牙耳机','无线耳机','tws','earbuds','headphones','écouteurs']),
  concept('camera','摄像头','electronics',['监控摄像头','camera','cameras','caméra']),
  concept('car-mp5','车载mp5','car-electronics',['车载主机','car mp5']),
  concept('display','智慧屏','computer-equipment',['会议机','id屏幕','显示屏','显示器','电脑','computer','monitor']),
  concept('phone-case','手机壳','phone-accessories',['phone case','coque de téléphone']),
  concept('phone-holder','手机支架','phone-accessories',['水杯架','phone holder']),
  concept('prayer-ring','智能礼拜戒指','electronics',['prayer ring']),
  concept('hair-dryer','吹风机','beauty-appliances',['热风梳','热感梳','hot air styler','hair dryer','sèche cheveux']),
  concept('hair-removal','脱毛仪','beauty-appliances',['hair removal device']),
  concept('purifier','净水器','appliances',['water purifier']),
  concept('dehumidifier','除湿机','appliances',['dehumidifier']),
  concept('sofa','沙发','seating',['sofa','couch','canapé','canape']),
  concept('chair','椅子','seating',['座椅','移位椅','按摩椅','chair','chairs','chaise','chaises']),
  concept('cabinet','柜子','storage-furniture',['斗柜','衣柜','橱柜','cabinet','dresser','commode','armoire']),
  concept('table','桌子','tables-beds',['餐桌','table','tables']),
  concept('bed','床','tables-beds',['普拉提床','单人床','双人床','木床','铁床','按摩床','bed','beds','lit']),
  concept('clothes','服装','clothing',['棉衣','衣服','马甲','背心','睡衣','牛仔长裤','牛仔裤','t恤','儿童衣服','clothes','jacket','vest','pyjamas','pajamas','jeans','t-shirt']),
  concept('socks','袜子','clothing',['socks','chaussettes']),
  concept('knitwear','针织三件套','clothing',['针织帽子','毛球帽','手套','围巾','gloves','scarf']),
  concept('blanket','毛毯','home-textiles',['礼拜毯','祈祷毯','blanket','blankets','couverture','prayer mat']),
  concept('fabric','布','fabrics',['印花布','纺织面料','fabric','tissu']),
  concept('slippers','拖鞋','shoes',['棉拖','洞洞鞋','slippers','sandals','pantoufles']),
  concept('sports-shoes','运动鞋','shoes',['板鞋','休闲鞋','sneakers','trainers','baskets']),
  concept('bags','包袋','bags',['背包','电脑包','女包','手提包','眼镜袋','backpack','laptop bag','handbag']),
  concept('paper-box','纸盒','paper-packaging',['飞机盒','抽屉盒','纸袋','carton','paper box','mailer box','paper bag']),
  concept('film','包装膜','plastic-packaging',['塑料膜','热收缩膜','热熔胶膜','pof','plastic film','wrapping film']),
  concept('plastic-box','塑料箱','plastic-packaging',['货箱宝','plastic box']),
  concept('cups','水杯','drinkware',['陶瓷杯','杯子','保温杯','显温直杯','cup','cups','mug','mugs','gobelet','tasse']),
  concept('kettle','茶壶','drinkware',['水壶','teapot','kettle','théière']),
  concept('plates','盘子','kitchenware',['瓷器盘子','碗','纸碗','瓷碗','汤碗','勺子','餐盘','玻璃器皿','plate','bowl','spoon','assiette']),
  concept('lights','灯','lighting',['灯具','灯饰','夜灯','舞台灯','led灯','light','lights','lamp','lampe']),
  concept('wall-panel','墙板','building',['墙面板','wall panel']),
  concept('veneer','木薄皮','building',['胡桃木薄皮','veneer']),
  concept('mirror','镜子','decor',['led镜子','mirror','miroir']),
  concept('flowers','仿真花','decor',['花艺','artificial flowers']),
  concept('sports','运动器材','sports',['足球','瑜伽垫','倒蹬机','football','yoga mat']),
  concept('outdoor','户外装备','sports',['凉亭','露营帐篷','帐篷','下水裤','tent','gazebo']),
  concept('toys','玩具','toys',['娃娃机','拼图','儿童固体水彩画本套装','toy','puzzle']),
  concept('auto-parts','汽车配件','auto-parts',['车身套件','皮卡车尾箱高盖','尾灯','缸套总成','auto bodykits','tail light']),
  concept('printing','3d打印耗材','printing',['pla','打印耗材','3d printing filament']),
  concept('printer','打印机','printing',['美甲打印机','3d打印机','printer','imprimante']),
];

const normalize=value=>String(value||'').normalize('NFKC').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/[-_‐–—]+/gu,' ').replace(/\s+/gu,' ').trim();
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const contains=(text,term)=>/\p{Script=Han}/u.test(term)&&term.length>1?text.includes(term):new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term)}(?=$|[^\\p{L}\\p{N}])`,'u').test(text);
const categories=new Map(PRODUCT_CATEGORIES.map(c=>[c.id,{...c,terms:c.aliases.map(normalize)}]));
const concepts=CONCEPTS.map(c=>({...c,terms:c.aliases.map(normalize)}));
function ancestors(id){const result=[];for(let c=categories.get(id);c;c=categories.get(c.parent))result.unshift(c.id);return result;}
const paths=new Map(PRODUCT_CATEGORIES.map(c=>[c.id,ancestors(c.id)]));
const describe=id=>({id,name:categories.get(id).name,path:paths.get(id).map(i=>categories.get(i).name)});
function scan(text){
  const found=concepts.map(c=>{
    // “电脑包”是箱包，不能仅因包含“电脑”就变成显示/电脑设备。
    const subject=c.id==='display'?text.replace(/电脑包|笔记本包|laptop bag|computer bag/gu,''):text;
    return {...c,matched:c.terms.filter(t=>contains(subject,t))};
  }).filter(c=>c.matched.length);
  // 类目词优先解释成类目，如“卫浴五金”，不把它当成某个具体商品。
  const explicit=PRODUCT_CATEGORIES.filter(c=>categories.get(c.id).terms.some(t=>contains(text,t))).map(c=>c.id);
  return {concepts:found,categories:new Set([...explicit,...found.map(c=>c.categoryId)].flatMap(id=>paths.get(id)))};
}
function distance(a,b){
  const x=Array.from(a),y=Array.from(b);if(Math.abs(x.length-y.length)>2)return 99;
  const matrix=Array.from({length:x.length+1},()=>Array(y.length+1).fill(0));
  for(let i=0;i<=x.length;i++)matrix[i][0]=i;for(let j=0;j<=y.length;j++)matrix[0][j]=j;
  for(let i=1;i<=x.length;i++)for(let j=1;j<=y.length;j++){
    matrix[i][j]=Math.min(matrix[i-1][j]+1,matrix[i][j-1]+1,matrix[i-1][j-1]+Number(x[i-1]!==y[j-1]));
    if(i>1&&j>1&&x[i-1]===y[j-2]&&x[i-2]===y[j-1])matrix[i][j]=Math.min(matrix[i][j],matrix[i-2][j-2]+1);
  }
  return matrix[x.length][y.length];
}
const noisy=new Set(['产品','商品','询价','报价','价格','智能','电子','塑料','不锈钢','材质','运输','shipping','price','product','products']);
function tokens(text){return [...new Set((text.match(/[a-z0-9][a-z0-9.]{1,}|[\p{Script=Han}]{1,}/gu)||[]).flatMap(t=>/\p{Script=Han}/u.test(t)&&t.length>2?[t,...Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2))]:[t]))].filter(t=>!noisy.has(t)).slice(0,24);}
function fuzzyConcepts(text){
  const words=(text.match(/[a-z]{4,30}|[\p{Script=Han}]{3,16}/gu)||[]).filter(t=>!noisy.has(t)).slice(0,24);
  const matches=[];
  for(const c of concepts){
    const match=c.terms.find(t=>words.some(w=>{
      const min=/\p{Script=Han}/u.test(t)?3:5;if(t.length<min||t.length>30||Math.abs(w.length-t.length)>1)return false;
      return distance(w,t)<=1;
    }));
    if(match)matches.push({...c,matched:[match],fuzzy:true});
  }
  return matches;
}
export function productQuery(value){
  const text=normalize(value),found=scan(text);
  if(!found.concepts.length){
    // 明确类目查询不因近字词再扩散到其他类目。
    if(!found.categories.size){
      found.concepts=/^[\p{Script=Han}]{2,}$/u.test(text)&&!noisy.has(text)?concepts.filter(c=>c.terms.some(t=>t.length>text.length&&t.startsWith(text))).map(c=>({...c,matched:[text],partial:true})):[];
      if(!found.concepts.length)found.concepts=fuzzyConcepts(text);
      for(const c of found.concepts)for(const id of paths.get(c.categoryId))found.categories.add(id);
    }
  }
  return {text,...found,tokens:tokens(text),categoriesInfo:[...found.categories].filter(id=>![...found.categories].some(other=>other!==id&&paths.get(other).includes(id))).map(describe)};
}
const profileCache=new Map();
export function productProfile(product,keywords=''){
  const key=product+'\0'+keywords;if(profileCache.has(key))return profileCache.get(key);
  const name=normalize(product),aliases=normalize(keywords),found=scan(name+' '+aliases);
  if(!found.concepts.length&&!found.categories.size){found.concepts=fuzzyConcepts(name);for(const c of found.concepts)for(const id of paths.get(c.categoryId))found.categories.add(id);}
  const result={name,aliases,...found,categoriesInfo:[...found.categories].filter(id=>![...found.categories].some(other=>other!==id&&paths.get(other).includes(id))).map(describe)};
  if(profileCache.size>=5000)profileCache.delete(profileCache.keys().next().value);profileCache.set(key,result);return result;
}
const match=(kind,rank,score,reason,category=null)=>({kind,rank,score,reason,...(category?{category:describe(category)}:{})});
export function rankProduct(query,row,profile=productProfile(row.product,row.keywords)){
  if(!query.text)return match('all',5,0,'');
  const pureCategory=query.categories.size>0&&!query.concepts.some(c=>!categories.get(c.categoryId).terms.includes(query.text));
  if(!pureCategory){
    if(profile.name===query.text)return match('exact',0,1000,'产品名称精准匹配');
    if(contains(profile.name,query.text)||query.text.length===1&&/\p{Script=Han}/u.test(query.text)&&profile.name.includes(query.text))return match('exact',0,900+Math.min(query.text.length,80),'产品名称包含搜索词');
    const same=query.concepts.map(q=>({q,p:profile.concepts.find(p=>p.id===q.id)})).filter(x=>x.p);
    const direct=same.find(({q})=>!q.fuzzy&&q.matched.some(t=>contains(profile.name,t)));
    if(direct)return match('exact',0,850+Math.min(direct.q.name.length,50),'产品名称命中：'+direct.q.name);
    if(same.length){const item=same.find(x=>!x.q.fuzzy&&!x.p.fuzzy)||same[0],fuzzy=item.q.fuzzy||item.p.fuzzy||item.q.partial;return match(fuzzy?'fuzzy':'alias',fuzzy?2:1,800,(fuzzy?'名称相近：':'相同产品别名：')+item.q.name);}
    if(contains(profile.aliases,query.text))return match('alias',1,750,'产品别名命中');
    for(const token of query.tokens)if(token.length>=2&&contains(profile.name,token))return match('name',2,500+token.length,'产品名称相关：'+token);
  }
  const shared=[...query.categories].filter(id=>profile.categories.has(id)).sort((a,b)=>paths.get(b).length-paths.get(a).length);
  if(shared.length)return match('category',3,100+paths.get(shared[0]).length*20,'同属'+categories.get(shared[0]).name,shared[0]);
  // 有明确产品或类目时，不让收货地址、材质或同条消息中的其他货物制造“相似产品”。
  if(query.concepts.length||query.categories.size)return null;
  const corpus=normalize(row.search_text||[row.product,row.specs,row.keywords].join(' '));
  const hits=query.tokens.filter(t=>contains(corpus,t));
  if(hits.length)return match('text',4,hits.length*3,'询价文字相关');
  return null;
}
