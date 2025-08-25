/*!
 * SvgNest - SVG形状嵌套优化算法
 * SVG形状的2D装箱优化库，使用无配合多边形(No-Fit Polygon)和遗传算法
 * Licensed under the MIT license
 */
 
(function(root){
	'use strict';
	
	function SvgNest(){
		var self = this;
		
		// SVG根元素
		var svg = null;
		
		// 保持对样式节点的引用，以维护颜色/填充信息
		this.style = null;
		
		// 待嵌套的零件数组
		var parts = null;
		
		// 零件的树形结构（包含孔洞信息）
		var tree = null;
		
		// 存储零件到DOM元素的映射关系，用于保持孔洞关系
		var partToElementMap = {};
		
		// 存储每个零件的数量设置
		var partQuantities = [];
		
		// 容器相关变量
		var bin = null;                // 容器SVG元素
		var binPolygon = null;         // 容器多边形
		var binBounds = null;          // 容器边界框
		
		// 无配合多边形缓存，用于提高性能
		var nfpCache = {};
		
		// 算法配置参数
		var config = {
			clipperScale: 10000000,    // Clipper库的缩放因子
			curveTolerance: 0.3,       // 曲线容差
			spacing: 0,                // 零件间距
			rotations: 4,              // 允许的旋转角度数量
			populationSize: 10,        // 遗传算法种群大小
			mutationRate: 10,          // 变异率(百分比)
			useHoles: false,           // 是否使用孔洞
			exploreConcave: false      // 是否探索凹面
		};
		
		// 算法状态变量
		this.working = false;          // 是否正在运行算法
		
		var GA = null;                 // 遗传算法实例
		var best = null;               // 当前最佳结果
		var workerTimer = null;        // 工作定时器
		var progress = 0;              // 进度(0-1)
		
		/**
		 * 解析SVG字符串，提取零件信息
		 * @param {string} svgstring - SVG字符串
		 * @returns {Element} 解析后的SVG元素
		 */
		this.parsesvg = function(svgstring){
			// 如果正在运行，先停止
			this.stop();
			
			// 重置状态
			bin = null;
			binPolygon = null;
			tree = null;
			partToElementMap = {};
			
			// 解析SVG
			svg = SvgParser.load(svgstring);
			
			// 获取样式信息
			this.style = SvgParser.getStyle();

			// 清理SVG元素
			svg = SvgParser.clean();
			
			// 构建零件树形结构
			tree = this.getParts(svg.childNodes);

			// 重新排序元素，使更深层的元素在顶部，便于鼠标悬停
			function zorder(paths){
				// 深度优先遍历
				var length = paths.length;
				for(var i=0; i<length; i++){
					if(paths[i].children && paths[i].children.length > 0){
						zorder(paths[i].children);
					}
				}
			}
			
			return svg;
		}
		
		/**
		 * 设置容器元素
		 * @param {Element} element - 作为容器的SVG元素
		 */
		this.setbin = function(element){
			if(!svg){
				return;
			}
			bin = element;
		}
		
		/**
		 * 设置零件数量
		 * @param {Object} quantities - 零件数量映射对象，键为零件索引，值为数量
		 */
		this.setPartQuantities = function(quantities){
			partQuantities = []
			for(var i=0; i<Object.keys(quantities).length; ++i) {
				partQuantities.push(quantities[i] || 1);
			}
		}
		
		/**
		 * 配置算法参数
		 * @param {Object} c - 配置对象
		 * @returns {Object} 当前配置
		 */
		this.config = function(c){
			// 清理输入参数
			
			if(!c){
				return config;
			}
			
			// 曲线容差设置
			if(c.curveTolerance && !GeometryUtil.almostEqual(parseFloat(c.curveTolerance), 0)){
				config.curveTolerance =  parseFloat(c.curveTolerance);
			}
			
			// 零件间距设置
			if('spacing' in c){
				config.spacing = parseFloat(c.spacing);
			}
			
			// 旋转角度数量设置
			if(c.rotations && parseInt(c.rotations) > 0){
				config.rotations = parseInt(c.rotations);
			}
			
			// 遗传算法种群大小设置
			if(c.populationSize && parseInt(c.populationSize) > 2){
				config.populationSize = parseInt(c.populationSize);
			}
			
			// 变异率设置
			if(c.mutationRate && parseInt(c.mutationRate) > 0){
				config.mutationRate = parseInt(c.mutationRate);
			}
			
			// 是否使用孔洞
			if('useHoles' in c){
				config.useHoles = !!c.useHoles;
			}
			
			// 是否探索凹面
			if('exploreConcave' in c){
				config.exploreConcave = !!c.exploreConcave;
			}
			
			// 更新解析器配置
			SvgParser.config({ tolerance: config.curveTolerance});
			
			// 重置状态
			best = null;
			nfpCache = {};
			binPolygon = null;
			GA = null;
			partToElementMap = {};
						
			return config;
		}
		
		/**
		 * 检查是否可以开始嵌套算法
		 * @returns {Object} 包含状态信息的对象
		 */
		this.canStart = function(){
			if(!svg){
				return { canStart: false, reason: 'noSvg', message: 'Please load an SVG file first' };
			}
			if(!bin){
				return { canStart: false, reason: 'noBin', message: 'Please select a bin (container) from the parts' };
			}
			
			// 检查是否有零件（除了bin之外）
			var partCount = svg.childNodes ? svg.childNodes.length : 0;
			if(partCount <= 1){
				return { canStart: false, reason: 'noParts', message: 'Please load an SVG file with multiple parts' };
			}
			
			// 尝试解析容器多边形来检查是否有效
			try {
				var testBinPolygon = SvgParser.polygonify(bin);
				if(!testBinPolygon) {
					return { canStart: false, reason: 'invalidBin', message: 'Selected bin could not be parsed by SvgParser.polygonify' };
				}
				
				testBinPolygon = this.cleanPolygon(testBinPolygon);
				
				if(!testBinPolygon || testBinPolygon.length < 3){
					return { canStart: false, reason: 'invalidBin', message: 'Selected bin cannot be converted to a valid polygon (cleaned polygon has ' + (testBinPolygon ? testBinPolygon.length : 0) + ' points). Please select a different part as bin.' };
				}
			} catch(e) {
				return { canStart: false, reason: 'binParseError', message: 'Error parsing the selected bin: ' + e.message };
			}
			
			return { canStart: true, reason: 'ready', message: 'Ready to start nesting' };
		}
		
		/**
		 * 开始嵌套算法
		 * @param {Function} progressCallback - 进度回调函数
		 * @param {Function} displayCallback - 显示回调函数
		 * @returns {Object} 包含是否成功启动和错误信息的对象
		 */
		this.start = function(progressCallback, displayCallback){
			if(!svg || !bin){
				return { success: false, message: 'SVG or bin not loaded' };
			}
			
			// 获取所有零件，排除容器
			parts = Array.prototype.slice.call(svg.childNodes);
			var binindex = parts.indexOf(bin);

			// 计算 bin 在 tree 的扁平先序序列中的索引（若找不到则返回 -1）
			function findBinTreeIndex(t, targetSource){
				var idx = -1;
				var cursor = 0;
				function dfs(node){
					if(idx !== -1){ return; }
					// 访问当前节点
					if(typeof node.source === 'number' && node.source === targetSource){
						idx = cursor;
					}
					cursor++;
					// 递归访问子节点（孔洞）
					if(node.children && node.children.length){
						for(var k=0;k<node.children.length;k++){
							dfs(node.children[k]);
							if(idx !== -1){ return; }
						}
					}
				}
				for(var i=0;i<t.length;i++){
					dfs(t[i]);
					if(idx !== -1){ break; }
				}
				return idx;
			}
			
			if(binindex >= 0){
				// 不将容器作为零件处理
				parts.splice(binindex, 1);
				
				tree = this.getParts(parts);
				binTreeIndex = findBinTreeIndex(tree, binindex);
				partQuantities.splice(binTreeIndex, 1);
			}
			
			// 首先构建初始树结构以获取顶层元素
			var initialTree = this.getParts(parts.slice(0));
			
			// 根据树的顶层元素数量设置复制零件
			var expandedParts = [];
			
			// 改进的辅助函数：递归克隆整个树结构，保持父子关系
			function cloneTreeStructure(treePart, allParts, treeIndex, copyIndex) {
				// 克隆主要元素
				var mainElement = allParts[treePart.source];
				var clonedMain;
				
				if(copyIndex === 0) {
					// 第一份使用原始元素
					clonedMain = mainElement;
				} else {
					// 后续份数使用深度克隆，保持所有子元素
					clonedMain = mainElement.cloneNode(true);
					clonedMain.setAttribute('data-tree-index', treeIndex);
					clonedMain.setAttribute('data-copy-index', copyIndex);
				}
				
				var elements = [clonedMain];
				
				// 递归处理子元素（孔洞）
				if(treePart.children && treePart.children.length > 0) {
					for(var k = 0; k < treePart.children.length; k++) {
						var childElements = cloneTreeStructure(treePart.children[k], allParts, treeIndex, copyIndex);
						elements = elements.concat(childElements);
					}
				}
				return elements;
			}
			
			// 根据设置的数量复制零件
			for(var i = 0; i < initialTree.length; i++){
				var treePart = initialTree[i];
				var quantity = partQuantities[i];
				
				// 根据数量复制整个树结构，保持树的层次关系
				for(var j = 0; j < quantity; j++){
					var treeElements = cloneTreeStructure(treePart, parts, i, j);
					expandedParts = expandedParts.concat(treeElements);
				}
			}
			
			// 使用扩展后的零件重新构建树结构
			// 重要：重新构建树结构以确保孔洞关系正确
			tree = this.getParts(expandedParts.slice(0));
			
			// 创建零件到DOM元素的映射关系，用于applyPlacement
			partToElementMap = {};
			var globalId = 0;
			
			// 辅助函数：递归创建完整的DOM结构
			function createElementStructure(treePart, allParts, treeIndex, copyIndex) {
				// 克隆主要元素
				var mainElement = allParts[treePart.source];
				var clonedMain;
				
				if(copyIndex === 0) {
					// 第一份使用原始元素的克隆
					clonedMain = mainElement.cloneNode(true);
				} else {
					// 后续份数使用深度克隆
					clonedMain = mainElement.cloneNode(true);
					clonedMain.setAttribute('data-tree-index', treeIndex);
					clonedMain.setAttribute('data-copy-index', copyIndex);
				}
				
				// 创建容器组来保持父子关系
				var container = document.createElementNS(svg.namespaceURI, 'g');
				container.appendChild(clonedMain);
				
				// 递归处理子元素（孔洞）
				if(treePart.children && treePart.children.length > 0) {
					for(var k = 0; k < treePart.children.length; k++) {
						var childContainer = createElementStructure(treePart.children[k], allParts, treeIndex, copyIndex);
						// 为孔洞添加标识类
						var childElement = childContainer.firstChild;
						if(childElement && (!childElement.getAttribute('class') || childElement.getAttribute('class').indexOf('hole') < 0)){
							childElement.setAttribute('class', (childElement.getAttribute('class') || '') + ' hole');
						}
						container.appendChild(childContainer);
					}
				}
				
				return container;
			}
			
			// 为每个树结构的每个副本创建完整的DOM结构映射
			for(var i = 0; i < initialTree.length; i++){
				var treePart = initialTree[i];
				var quantity = partQuantities[i] || 1;
				
				// 根据数量复制整个树结构
				for(var j = 0; j < quantity; j++){
					var elementStructure = createElementStructure(treePart, parts, i, j);
					partToElementMap[globalId] = elementStructure;
					globalId++;
				}
			}
			
			// 对树进行偏移处理，为零件添加间距
			offsetTree(tree, 0.5*config.spacing, this.polygonOffset.bind(this));

			// 递归对树进行偏移处理
			function offsetTree(t, offset, offsetFunction){
				for(var i=0; i<t.length; i++){
					var offsetpaths = offsetFunction(t[i], offset);
					if(offsetpaths.length == 1){
						// 就地替换数组项
						Array.prototype.splice.apply(t[i], [0, t[i].length].concat(offsetpaths[0]));
					}
					
					// 对子节点（孔洞）进行反向偏移
					if(t[i].childNodes && t[i].childNodes.length > 0){
						offsetTree(t[i].childNodes, -offset, offsetFunction);
					}
				}
			}
			
			// 将容器转换为多边形
			binPolygon = SvgParser.polygonify(bin);
			binPolygon = this.cleanPolygon(binPolygon);
						
			if(!binPolygon || binPolygon.length < 3){
				return { success: false, message: 'Selected bin cannot be converted to a valid polygon (points: ' + (binPolygon ? binPolygon.length : 0) + ')' };
			}
			
			// 计算容器边界
			binBounds = GeometryUtil.getPolygonBounds(binPolygon);
						
			// 如果设置了间距，对容器进行内偏移
			if(config.spacing > 0){
				var offsetBin = this.polygonOffset(binPolygon, -0.5*config.spacing);
				if(offsetBin.length == 1){
					// 如果偏移结果包含0个或多于1个路径，说明出现了问题
					binPolygon = offsetBin.pop();
				}
			}
						
			binPolygon.id = -1;
			
			// 将容器移到原点
			var xbinmax = binPolygon[0].x;
			var xbinmin = binPolygon[0].x;
			var ybinmax = binPolygon[0].y;
			var ybinmin = binPolygon[0].y;
			
			// 计算容器的边界框
			for(var i=1; i<binPolygon.length; i++){
				if(binPolygon[i].x > xbinmax){
					xbinmax = binPolygon[i].x;
				}
				else if(binPolygon[i].x < xbinmin){
					xbinmin = binPolygon[i].x;
				}
				if(binPolygon[i].y > ybinmax){
					ybinmax = binPolygon[i].y;
				}
				else if(binPolygon[i].y < ybinmin){
					ybinmin = binPolygon[i].y;
				}
			}
			
			// 将容器移动到原点
			for(i=0; i<binPolygon.length; i++){
				binPolygon[i].x -= xbinmin;
				binPolygon[i].y -= ybinmin;
			}
			
			// 设置容器尺寸
			binPolygon.width = xbinmax-xbinmin;
			binPolygon.height = ybinmax-ybinmin;
			
			// 确保所有路径具有相同的绕向方向（逆时针）
			if(GeometryUtil.polygonArea(binPolygon) > 0){
				binPolygon.reverse();
			}
			
			// 移除重复的端点，确保逆时针绕向
			for(i=0; i<tree.length; i++){
				var start = tree[i][0];
				var end = tree[i][tree[i].length-1];
				if(start == end || (GeometryUtil.almostEqual(start.x,end.x) && GeometryUtil.almostEqual(start.y,end.y))){
					tree[i].pop();
				}
				
				if(GeometryUtil.polygonArea(tree[i]) > 0){
					tree[i].reverse();
				}
			}
			
			var self = this;
			this.working = false;
			
			// 启动工作定时器，定期运行遗传算法
			workerTimer = setInterval(function(){
				if(!self.working){
					self.launchWorkers.call(self, tree, binPolygon, config, progressCallback, displayCallback);
					self.working = true;
				}
				
				progressCallback(progress);
			}, 100);
			
			return { success: true, message: 'Nesting started successfully' };
		}
		
		/**
		 * 启动工作线程进行嵌套计算
		 * @param {Array} tree - 零件树
		 * @param {Array} binPolygon - 容器多边形
		 * @param {Object} config - 配置参数
		 * @param {Function} progressCallback - 进度回调
		 * @param {Function} displayCallback - 显示回调
		 */
		this.launchWorkers = function(tree, binPolygon, config, progressCallback, displayCallback){
			// 数组随机打乱函数
			function shuffle(array) {
			  var currentIndex = array.length, temporaryValue, randomIndex ;

			  // 当还有元素需要打乱时...
			  while (0 !== currentIndex) {

				// 选择一个剩余元素...
				randomIndex = Math.floor(Math.random() * currentIndex);
				currentIndex -= 1;

				// 与当前元素交换
				temporaryValue = array[currentIndex];
				array[currentIndex] = array[randomIndex];
				array[randomIndex] = temporaryValue;
			  }

			  return array;
			}
			
			var i,j;
			
			if(GA === null){
				// 初始化新的遗传算法
				var adam = tree.slice(0);

				// 按面积递减排序作为种子
				adam.sort(function(a, b){
					return Math.abs(GeometryUtil.polygonArea(b)) - Math.abs(GeometryUtil.polygonArea(a));
				});
				
				GA = new GeneticAlgorithm(adam, binPolygon, config);
			}
			
			var individual = null;
			
			// 评估种群中的所有个体
			for(i=0; i<GA.population.length; i++){
				if(!GA.population[i].fitness){
					individual = GA.population[i];
					break;
				}
			}
			
			if(individual === null){
				// 所有个体都已评估，开始下一代
				GA.generation();
				individual = GA.population[1];
			}
			
			// 获取当前个体的放置列表和旋转角度
			var placelist = individual.placement;
			var rotations = individual.rotation;
			
			// 收集零件ID
			var ids = [];
			for(i=0; i<placelist.length; i++){
				ids.push(placelist[i].id);
				placelist[i].rotation = rotations[i];
			}
			
			// 准备无配合多边形(NFP)计算所需的配对
			var nfpPairs = [];
			var key;
			var newCache = {};
			
			// 为每个零件计算与容器和其他零件的NFP
			for(i=0; i<placelist.length; i++){
				var part = placelist[i];
				// 零件与容器的内部NFP
				key = {A: binPolygon.id, B: part.id, inside: true, Arotation: 0, Brotation: rotations[i]};
				if(!nfpCache[JSON.stringify(key)]){
					nfpPairs.push({A: binPolygon, B: part, key: key});
				}
				else{
					newCache[JSON.stringify(key)] = nfpCache[JSON.stringify(key)]
				}
				// 零件与已放置零件的外部NFP
				for(j=0; j<i; j++){
					var placed = placelist[j];
					key = {A: placed.id, B: part.id, inside: false, Arotation: rotations[j], Brotation: rotations[i]};
					if(!nfpCache[JSON.stringify(key)]){
						nfpPairs.push({A: placed, B: part, key: key});
					}
					else{
						newCache[JSON.stringify(key)] = nfpCache[JSON.stringify(key)]
					}
				}
			}
			
			// 只为一个周期保留缓存
			nfpCache = newCache;
			
			var worker = new PlacementWorker(binPolygon, placelist.slice(0), ids, rotations, config, nfpCache);
			
			var p = new Parallel(nfpPairs, {
				env: {
					searchEdges: config.exploreConcave,
					useHoles: config.useHoles
				},
				evalPath: 'util/eval.js'
			});
			
			p.require('matrix.js');
			p.require('geometryutil.js');
			p.require('placementworker.js');
			p.require('clipper.js');
			
			var self = this;
			var spawncount = 0;
			p._spawnMapWorker = function (i, cb, done, env, wrk){
				// hijack the worker call to check progress
				progress = spawncount++/nfpPairs.length;
				return Parallel.prototype._spawnMapWorker.call(p, i, cb, done, env, wrk);
			}
			
			p.map(function(pair){
				if(!pair || pair.length == 0){
					return null;
				}
				var searchEdges = global.env.searchEdges;
				var useHoles = global.env.useHoles;
				
				var A = rotatePolygon(pair.A, pair.key.Arotation);
				var B = rotatePolygon(pair.B, pair.key.Brotation);

				var nfp;
				
				if(pair.key.inside){
					if(GeometryUtil.isRectangle(A, 0.001)){
						nfp = GeometryUtil.noFitPolygonRectangle(A,B);
					}
					else{
						nfp = GeometryUtil.noFitPolygon(A,B,true,searchEdges);
					}
					
					// ensure all interior NFPs have the same winding direction
					if(nfp && nfp.length > 0){
						for(var i=0; i<nfp.length; i++){
							if(GeometryUtil.polygonArea(nfp[i]) > 0){
								nfp[i].reverse();
							}
						}
					}
					else{
						// warning on null inner NFP
						// this is not an error, as the part may simply be larger than the bin or otherwise unplaceable due to geometry
						log('NFP Warning: ', pair.key);
					}
				}
				else{
					if(searchEdges){
						nfp = GeometryUtil.noFitPolygon(A,B,false,searchEdges);
					}
					else{
						nfp = minkowskiDifference(A,B);
					}
					// sanity check
					if(!nfp || nfp.length == 0){
						log('NFP Error: ', pair.key);
						log('A: ',JSON.stringify(A));
						log('B: ',JSON.stringify(B));
						return null;
					}
					
					for(var i=0; i<nfp.length; i++){
						if(!searchEdges || i==0){ // if searchedges is active, only the first NFP is guaranteed to pass sanity check
							if(Math.abs(GeometryUtil.polygonArea(nfp[i])) < Math.abs(GeometryUtil.polygonArea(A))){
								log('NFP Area Error: ', Math.abs(GeometryUtil.polygonArea(nfp[i])), pair.key);
								log('NFP:', JSON.stringify(nfp[i]));
								log('A: ',JSON.stringify(A));
								log('B: ',JSON.stringify(B));
								nfp.splice(i,1);
								return null;
							}
						}
					}
					
					if(nfp.length == 0){
						return null;
					}
					
					// for outer NFPs, the first is guaranteed to be the largest. Any subsequent NFPs that lie inside the first are holes
					for(var i=0; i<nfp.length; i++){
						if(GeometryUtil.polygonArea(nfp[i]) > 0){
							nfp[i].reverse();
						}
						
						if(i > 0){
							if(GeometryUtil.pointInPolygon(nfp[i][0], nfp[0])){
								if(GeometryUtil.polygonArea(nfp[i]) < 0){
									nfp[i].reverse();
								}
							}
						}
					}
					
					// generate nfps for children (holes of parts) if any exist
					if(useHoles && A.childNodes && A.childNodes.length > 0){
						var Bbounds = GeometryUtil.getPolygonBounds(B);
						
						for(var i=0; i<A.childNodes.length; i++){
							var Abounds = GeometryUtil.getPolygonBounds(A.childNodes[i]);

							// no need to find nfp if B's bounding box is too big
							if(Abounds.width > Bbounds.width && Abounds.height > Bbounds.height){
							
								var cnfp = GeometryUtil.noFitPolygon(A.childNodes[i],B,true,searchEdges);
								// ensure all interior NFPs have the same winding direction
								if(cnfp && cnfp.length > 0){
									for(var j=0; j<cnfp.length; j++){
										if(GeometryUtil.polygonArea(cnfp[j]) < 0){
											cnfp[j].reverse();
										}
										nfp.push(cnfp[j]);
									}
								}
							
							}
						}
					}
				}
				
				function log(){
					if(typeof console !== "undefined") {
						console.log.apply(console,arguments);
					}
				}
				
				function toClipperCoordinates(polygon){
					var clone = [];
					for(var i=0; i<polygon.length; i++){
						clone.push({
							X: polygon[i].x,
							Y: polygon[i].y
						});
					}
	
					return clone;
				};
				
				function toNestCoordinates(polygon, scale){
					var clone = [];
					for(var i=0; i<polygon.length; i++){
						clone.push({
							x: polygon[i].X/scale,
							y: polygon[i].Y/scale
						});
					}
	
					return clone;
				};
				
				function minkowskiDifference(A, B){
					var Ac = toClipperCoordinates(A);
					ClipperLib.JS.ScaleUpPath(Ac, 10000000);
					var Bc = toClipperCoordinates(B);
					ClipperLib.JS.ScaleUpPath(Bc, 10000000);
					for(var i=0; i<Bc.length; i++){
						Bc[i].X *= -1;
						Bc[i].Y *= -1;
					}
					var solution = ClipperLib.Clipper.MinkowskiSum(Ac, Bc, true);
					var clipperNfp;
		
					var largestArea = null;
					for(i=0; i<solution.length; i++){
						var n = toNestCoordinates(solution[i], 10000000);
						var sarea = GeometryUtil.polygonArea(n);
						if(largestArea === null || largestArea > sarea){
							clipperNfp = n;
							largestArea = sarea;
						}
					}
		
					for(var i=0; i<clipperNfp.length; i++){
						clipperNfp[i].x += B[0].x;
						clipperNfp[i].y += B[0].y;
					}
		
					return [clipperNfp];
				}
				
				return {key: pair.key, value: nfp};
			}).then(function(generatedNfp){
				if(generatedNfp){
					for(var i=0; i<generatedNfp.length; i++){
						var Nfp = generatedNfp[i];
												
						if(Nfp){
							// a null nfp means the nfp could not be generated, either because the parts simply don't fit or an error in the nfp algo
							var key = JSON.stringify(Nfp.key);
							nfpCache[key] = Nfp.value;
						}
					}
				}
				worker.nfpCache = nfpCache;
				
				// can't use .spawn because our data is an array
				// move heavy data (binPolygon/config/nfpCache/paths) into the data payload to avoid huge env stringify
				var placementPayload = {
					paths: placelist.slice(0),
					binPolygon: binPolygon,
					config: config,
					nfpCache: nfpCache
				};
				var p2 = new Parallel([placementPayload], {
					env: {},
					evalPath: 'util/eval.js'
				});
				
				p2.require('json.js');
				p2.require('clipper.js');
				p2.require('matrix.js');
				p2.require('geometryutil.js');
				p2.require('placementworker.js');				
				
				p2.map(worker.placePaths).then(function(placements){
					if(!placements || placements.length == 0){
						return;
					}
					
					individual.fitness = placements[0].fitness;
					var bestresult = placements[0];
					
					for(var i=1; i<placements.length; i++){
						if(placements[i].fitness < bestresult.fitness){
							bestresult = placements[i];
						}
					}
					
					if(!best || bestresult.fitness < best.fitness){
						best = bestresult;
						
						var placedArea = 0;
						var totalArea = 0;
						var numParts = placelist.length;
						var numPlacedParts = 0;
						
						for(i=0; i<best.placements.length; i++){
							totalArea += Math.abs(GeometryUtil.polygonArea(binPolygon));
							for(var j=0; j<best.placements[i].length; j++){
								placedArea += Math.abs(GeometryUtil.polygonArea(tree[best.placements[i][j].id]));
								numPlacedParts++;
							}
						}
						displayCallback(self.applyPlacement(best.placements), placedArea/totalArea, numPlacedParts, numParts);
					}
					else{
						displayCallback();
					}
					self.working = false;
				}, function (err) {
					console.log(err);
				});
			}, function (err) {
				console.log(err);
			});
		}
		
		/**
		 * 将SVG路径列表转换为树形结构
		 * 假设没有相交，返回一个树，其中奇数叶子是零件，偶数叶子是孔洞
		 * @param {Array} paths - SVG路径数组
		 * @returns {Array} 转换后的树形结构
		 */
		this.getParts = function(paths){
			
			var i, j;
			var polygons = [];
			
			var numChildren = paths.length;
			// 将每个路径转换为多边形
			for(i=0; i<numChildren; i++){
				var poly = SvgParser.polygonify(paths[i]);
				poly = this.cleanPolygon(poly);
				
				// 警告：如果多边形无法处理，将从嵌套中排除
				if(poly && poly.length > 2 && Math.abs(GeometryUtil.polygonArea(poly)) > config.curveTolerance*config.curveTolerance){
					poly.source = i;					
					polygons.push(poly);
				}
			}
						
			// 将列表转换为树结构
			toTree(polygons);
			
			function toTree(list, idstart){
				var parents = [];
				var i,j;
				
				// 为每个叶子分配唯一ID
				var id = idstart || 0;
				
				for(i=0; i<list.length; i++){
					var p = list[i];
					
					var ischild = false;
					// 检查当前多边形是否在其他多边形内部
					for(j=0; j<list.length; j++){
						if(j==i){
							continue;
						}
						if(GeometryUtil.pointInPolygon(p[0], list[j]) === true){
							if(!list[j].children){
								list[j].children = [];
							}
							list[j].children.push(p);
							p.parent = list[j];
							ischild = true;
							break;
						}
					}
					
					if(!ischild){
						parents.push(p);
					}
				}
				
				// 移除子元素，只保留父元素
				for(i=0; i<list.length; i++){
					if(parents.indexOf(list[i]) < 0){
						list.splice(i, 1);
						i--;
					}
				}
				
				// 为父元素分配ID
				for(i=0; i<parents.length; i++){
					parents[i].id = id;
					id++;
				}
				
				// 递归处理子元素
				for(i=0; i<parents.length; i++){
					if(parents[i].children){
						id = toTree(parents[i].children, id);
					}
				}
								
				return id;
			};
			
			return polygons;
		};
		
		/**
		 * 使用clipper库对给定多边形进行偏移
		 * 正偏移扩展多边形，负偏移收缩多边形
		 * @param {Array} polygon - 输入多边形
		 * @param {number} offset - 偏移距离
		 * @returns {Array} 偏移后的多边形数组
		 */
		this.polygonOffset = function(polygon, offset){
			if(!offset || offset == 0 || GeometryUtil.almostEqual(offset, 0)){
				return polygon;
			}
			
			var p = this.svgToClipper(polygon);
			
			var miterLimit = 2;
			var co = new ClipperLib.ClipperOffset(miterLimit, config.curveTolerance*config.clipperScale);
			co.AddPath(p, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
			
			var newpaths = new ClipperLib.Paths();
			co.Execute(newpaths, offset*config.clipperScale);
						
			var result = [];
			for(var i=0; i<newpaths.length; i++){
				result.push(this.clipperToSvg(newpaths[i]));
			}
			
			return result;
		};
		
		/**
		 * 返回满足曲线容差的简化多边形
		 * @param {Array} polygon - 输入多边形
		 * @returns {Array|null} 清理后的多边形，如果无效则返回null
		 */
		this.cleanPolygon = function(polygon){
			var p = this.svgToClipper(polygon);
			// 移除自相交并找到剩余的最大多边形
			var simple = ClipperLib.Clipper.SimplifyPolygon(p, ClipperLib.PolyFillType.pftNonZero);
			
			if(!simple || simple.length == 0){
				return null;
			}
			
			var biggest = simple[0];
			var biggestarea = Math.abs(ClipperLib.Clipper.Area(biggest));
			for(var i=1; i<simple.length; i++){
				var area = Math.abs(ClipperLib.Clipper.Area(simple[i]));
				if(area > biggestarea){
					biggest = simple[i];
					biggestarea = area;
				}
			}

			// 清理奇点、重合点和边
			var clean = ClipperLib.Clipper.CleanPolygon(biggest, config.curveTolerance*config.clipperScale);
						
			if(!clean || clean.length == 0){
				return null;
			}
						
			return this.clipperToSvg(clean);
		}
		
		/**
		 * 将多边形从普通浮点坐标转换为clipper使用的整数坐标
		 * 同时将x/y转换为X/Y
		 * @param {Array} polygon - 输入多边形
		 * @returns {Array} clipper格式的多边形
		 */
		this.svgToClipper = function(polygon){
			var clip = [];
			for(var i=0; i<polygon.length; i++){
				clip.push({X: polygon[i].x, Y: polygon[i].y});
			}
			
			ClipperLib.JS.ScaleUpPath(clip, config.clipperScale);
			
			return clip;
		}
		
		/**
		 * 将clipper格式的多边形转换为SVG格式
		 * @param {Array} polygon - clipper格式的多边形
		 * @returns {Array} SVG格式的多边形
		 */
		this.clipperToSvg = function(polygon){
			var normal = [];
			
			for(var i=0; i<polygon.length; i++){
				normal.push({x: polygon[i].X/config.clipperScale, y: polygon[i].Y/config.clipperScale});
			}
			
			return normal;
		}
		
		// returns an array of SVG elements that represent the placement, for export or rendering
		this.applyPlacement = function(placement){
			var i, j, k;
			var svglist = [];

			for(i=0; i<placement.length; i++){
				var newsvg = svg.cloneNode(false);
				newsvg.setAttribute('viewBox', '0 0 '+binBounds.width+' '+binBounds.height);
				newsvg.setAttribute('width',binBounds.width + 'px');
				newsvg.setAttribute('height',binBounds.height + 'px');
				var binclone = bin.cloneNode(false);
				
				binclone.setAttribute('class','bin');
				binclone.setAttribute('transform','translate('+(-binBounds.x)+' '+(-binBounds.y)+')');
				newsvg.appendChild(binclone);

				for(j=0; j<placement[i].length; j++){
					var p = placement[i][j];
					
					// 使用预建立的映射关系获取完整的DOM结构
					if(partToElementMap[p.id]){
						// 克隆完整的结构以避免重复使用同一个DOM元素
						var partStructure = partToElementMap[p.id].cloneNode(true);
						
						// 应用变换到整个结构
						partStructure.setAttribute('transform','translate('+p.x+' '+p.y+') rotate('+p.rotation+')');
						
						newsvg.appendChild(partStructure);
					}
				}
				
				svglist.push(newsvg);
			}			// flatten the given tree into a list
			function _flattenTree(t, hole){
				var flat = [];
				for(var i=0; i<t.length; i++){
					flat.push(t[i]);
					t[i].hole = hole;
					if(t[i].children && t[i].children.length > 0){
						flat = flat.concat(_flattenTree(t[i].children, !hole));
					}
				}
				
				return flat;
			}
			
			return svglist;
		}
		
		/**
		 * 停止嵌套算法
		 */
		this.stop = function(){
			this.working = false;
			if(workerTimer){
				clearInterval(workerTimer);
			}
		};
	}
	
	/**
	 * 遗传算法类
	 * 用于优化零件的放置顺序和旋转角度
	 * @param {Array} adam - 初始零件序列
	 * @param {Array} bin - 容器多边形
	 * @param {Object} config - 配置参数
	 */
	function GeneticAlgorithm(adam, bin, config){
	
		this.config = config || { populationSize: 10, mutationRate: 10, rotations: 4 };
		this.binBounds = GeometryUtil.getPolygonBounds(bin);
		
		// 种群是个体的数组。每个个体是一个对象，表示插入顺序和每个零件的旋转角度
		var angles = [];
		for(var i=0; i<adam.length; i++){
			angles.push(this.randomAngle(adam[i]));
		}
		
		this.population = [{placement: adam, rotation: angles}];
		
		// 生成初始种群
		while(this.population.length < config.populationSize){
			var mutant = this.mutate(this.population[0]);
			this.population.push(mutant);
		}
	}
	
	/**
	 * 返回随机的插入角度
	 * 避免使用明显不合适的角度（零件不适合容器的角度）
	 * @param {Array} part - 零件多边形
	 * @returns {number} 随机角度
	 */
	GeneticAlgorithm.prototype.randomAngle = function(part){
		
		var angleList = [];
		for(var i=0; i<Math.max(this.config.rotations,1); i++){
			angleList.push(i*(360/this.config.rotations));
		}
		
		// 随机打乱数组的函数
		function shuffleArray(array) {
			for (var i = array.length - 1; i > 0; i--) {
				var j = Math.floor(Math.random() * (i + 1));
				var temp = array[i];
				array[i] = array[j];
				array[j] = temp;
			}
			return array;
		}
		
		angleList = shuffleArray(angleList);

		// 选择适合容器的角度
		for(i=0; i<angleList.length; i++){
			var rotatedPart = GeometryUtil.rotatePolygon(part, angleList[i]);
			
			// 不使用明显不合适的角度（零件不适合容器）
			if(rotatedPart.width < this.binBounds.width && rotatedPart.height < this.binBounds.height){
				return angleList[i];
			}
		}
		
		return 0;
	}
	
	/**
	 * 返回具有给定变异率的变异个体
	 * @param {Object} individual - 要变异的个体
	 * @returns {Object} 变异后的个体
	 */
	GeneticAlgorithm.prototype.mutate = function(individual){
		var clone = {placement: individual.placement.slice(0), rotation: individual.rotation.slice(0)};
		for(var i=0; i<clone.placement.length; i++){
			var rand = Math.random();
			// 交换相邻零件的位置
			if(rand < 0.01*this.config.mutationRate){
				var j = i+1;
				
				if(j < clone.placement.length){
					var temp = clone.placement[i];
					clone.placement[i] = clone.placement[j];
					clone.placement[j] = temp;
				}
			}
			
			rand = Math.random();
			// 随机改变旋转角度
			if(rand < 0.01*this.config.mutationRate){
				clone.rotation[i] = this.randomAngle(clone.placement[i]);
			}
		}
		
		return clone;
	}
	
	/**
	 * 单点交叉操作
	 * 将两个个体的基因进行交叉，产生两个新的子代
	 * @param {Object} male - 父代个体1
	 * @param {Object} female - 父代个体2
	 * @returns {Array} 包含两个子代的数组
	 */
	GeneticAlgorithm.prototype.mate = function(male, female){
		var cutpoint = Math.round(Math.min(Math.max(Math.random(), 0.1), 0.9)*(male.placement.length-1));
		
		var gene1 = male.placement.slice(0,cutpoint);
		var rot1 = male.rotation.slice(0,cutpoint);
		
		var gene2 = female.placement.slice(0,cutpoint);
		var rot2 = female.rotation.slice(0,cutpoint);
		
		var i;
		
		// 补充剩余的基因，确保没有重复
		for(i=0; i<female.placement.length; i++){
			if(!contains(gene1, female.placement[i].id)){
				gene1.push(female.placement[i]);
				rot1.push(female.rotation[i]);
			}
		}
		
		for(i=0; i<male.placement.length; i++){
			if(!contains(gene2, male.placement[i].id)){
				gene2.push(male.placement[i]);
				rot2.push(male.rotation[i]);
			}
		}
		
		// 检查基因中是否包含指定ID
		function contains(gene, id){
			for(var i=0; i<gene.length; i++){
				if(gene[i].id == id){
					return true;
				}
			}
			return false;
		}
		
		return [{placement: gene1, rotation: rot1},{placement: gene2, rotation: rot2}];
	}

	/**
	 * 产生新一代种群
	 * 使用选择、交叉和变异操作
	 */
	GeneticAlgorithm.prototype.generation = function(){
				
		// 适应度较高的个体更有可能被选择进行交配
		this.population.sort(function(a, b){
			return a.fitness - b.fitness;
		});
		
		// 适应度最高的个体在新一代中保留（精英主义）
		var newpopulation = [this.population[0]];
		
		// 生成新的种群
		while(newpopulation.length < this.population.length){
			var male = this.randomWeightedIndividual();
			var female = this.randomWeightedIndividual(male);
			
			// 每次交配产生两个子代
			var children = this.mate(male, female);
			
			// 轻微变异子代
			newpopulation.push(this.mutate(children[0]));
				
			if(newpopulation.length < this.population.length){
				newpopulation.push(this.mutate(children[1]));
			}
		}
				
		this.population = newpopulation;
	}
	
	/**
	 * 从种群中返回一个随机个体，权重偏向列表前端
	 * （适应度值较低的更有可能被选择）
	 * @param {Object} exclude - 要排除的个体（可选）
	 * @returns {Object} 被选择的个体
	 */
	GeneticAlgorithm.prototype.randomWeightedIndividual = function(exclude){
		var pop = this.population.slice(0);
		
		if(exclude && pop.indexOf(exclude) >= 0){
			pop.splice(pop.indexOf(exclude),1);
		}
		
		var rand = Math.random();
		
		var lower = 0;
		var weight = 1/pop.length;
		var upper = weight;
		
		// 使用轮盘赌选择，适应度好的个体有更高的选择概率
		for(var i=0; i<pop.length; i++){
			// 如果随机数落在下限和上限之间，选择这个个体
			if(rand > lower && rand < upper){
				return pop[i];
			}
			lower = upper;
			upper += 2*weight * ((pop.length-i)/pop.length);
		}
		
		return pop[0];
	}
	
	// 将SvgNest实例暴露到全局作用域
	root.SvgNest = new SvgNest();
	
})(window);
