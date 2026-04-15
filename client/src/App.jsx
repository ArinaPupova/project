import React, { useEffect, useRef, useState, useCallback } from 'react';
import './index.css';

import 'ol/ol.css';
import Map from 'ol/Map';
import View from 'ol/View';
import TileLayer from 'ol/layer/Tile';
import OSM from 'ol/source/OSM';
import VectorLayer from 'ol/layer/Vector';
import VectorSource from 'ol/source/Vector';
import Cluster from 'ol/source/Cluster';
import GeoJSON from 'ol/format/GeoJSON';
import { Style, Circle as CircleStyle, Fill, Stroke, Text } from 'ol/style';
import Overlay from 'ol/Overlay';
import { useGeographic } from 'ol/proj';

useGeographic(); 

const API_BASE = "/api";

// Цвета для тональностей
const COLORS = {
  POSITIVE: '#035f40', // green
  NEGATIVE: '#802307', // red
  NEUTRAL: '#f59e0b'   // yellow
};

// Функция стиля для пунсонов и кластеров
const clusterStyleFunction = (feature) => {
  const size = feature.get('features').length;
  let color = COLORS.NEUTRAL;
  let strokeColor = 'rgba(255, 255, 255, 0.5)';

  if (size === 1) {
    const sentiment = (feature.get('features')[0].get('sentiment') || "NEUTRAL").toUpperCase();
    color = COLORS[sentiment] || COLORS.NEUTRAL;
  } else {
    // Вычисляем среднюю тональность для кластера
    const sentiments = feature.get('features').map(f => (f.get('sentiment') || "NEUTRAL").toUpperCase());
    const score = sentiments.reduce((acc, s) => {
      if (s === 'POSITIVE') return acc + 1;
      if (s === 'NEGATIVE') return acc - 1;
      return acc;
    }, 0) / size;

    if (score > 0.3) color = COLORS.POSITIVE;
    else if (score < -0.3) color = COLORS.NEGATIVE;
  }

  return new Style({
    image: new CircleStyle({
      radius: size === 1 ? 10 : Math.min(15 + size, 30),
      stroke: new Stroke({ color: strokeColor, width: 2 }),
      fill: new Fill({ color: color })
    }),
    text: new Text({
      text: size > 1 ? size.toString() : '',
      fill: new Fill({ color: '#fff' }),
      font: '600 12px Inter, sans-serif'
    })
  });
};

function App() {
  const mapElement = useRef();
  const mapRef = useRef();
  const popupElement = useRef();
  const popupOverlay = useRef();
  const vectorSourceRef = useRef(new VectorSource());
  const vectorLayerRef = useRef();

  const [loading, setLoading] = useState(true);
  const [news, setNews] = useState([]);
  const [availableTags, setAvailableTags] = useState([]);
  const [selectedCluster, setSelectedCluster] = useState(null);

  // Фильтры
  const [days, setDays] = useState(5);
  const [sentimentFilters, setSentimentFilters] = useState({
    POSITIVE: true,
    NEGATIVE: true,
    NEUTRAL: true
  });
  const [selectedTags, setSelectedTags] = useState([]);

  const [lastTimestamp, setLastTimestamp] = useState(null);
  
  // 1. Добавляем состояние в начало компонента App
  const [calcMethod, setCalcMethod] = useState('simple'); // 'simple' или 'weighted'

  // 2. Обновляем функцию стиля (теперь она внутри App или использует внешние параметры)
  const getClusterStyle = useCallback((feature) => {
    const size = feature.get('features').length;
    const features = feature.get('features');
    
    let color = COLORS.NEUTRAL;

    if (size === 1) {
      const sentiment = (features[0].get('sentiment') || "NEUTRAL").toUpperCase();
      color = COLORS[sentiment] || COLORS.NEUTRAL;
    } else {
      const sentiments = features.map(f => (f.get('sentiment') || "NEUTRAL").toUpperCase());
      
      // Выбор коэффициентов
      const weights = calcMethod === 'weighted' 
        ? { POSITIVE: 1.5, NEGATIVE: -2, NEUTRAL: 0 } 
        : { POSITIVE: 1, NEGATIVE: -1, NEUTRAL: 0 };

      const score = sentiments.reduce((acc, s) => acc + (weights[s] || 0), 0) / size;

      // Пороги окрашивания
      if (score > 0.3) color = COLORS.POSITIVE;
      else if (score < -0.3) color = COLORS.NEGATIVE;
      else color = COLORS.NEUTRAL;
    }

    return new Style({
      image: new CircleStyle({
        radius: size === 1 ? 10 : Math.min(15 + size, 30),
        stroke: new Stroke({ color: 'rgba(255, 255, 255, 0.5)', width: 2 }),
        fill: new Fill({ color: color })
      }),
      text: new Text({
        text: size > 1 ? size.toString() : '',
        fill: new Fill({ color: '#fff' }),
        font: '600 12px Inter, sans-serif'
      })
    });
  }, [calcMethod]); // Функция пересоздается при смене метода

  // 3. В useEffect, где создается векторный слой, нужно обновлять стиль
  useEffect(() => {
    if (vectorLayerRef.current) {
      vectorLayerRef.current.setStyle(getClusterStyle);
      vectorLayerRef.current.changed();
    }
  }, [calcMethod, getClusterStyle]);

  // Загрузка данных
  const loadData = useCallback(async (force = false) => {
    try {
      // Шаг 1: Проверяем метку времени на сервере
      const checkRes = await fetch(`${API_BASE}/last-update`);
      const checkData = await checkRes.json();
      
      
      // Если время на сервере совпадает с тем, что мы уже загрузили — выходим
      if (!force && lastTimestamp === checkData.last_update) {
        //console.log("Данные на карте актуальны.");
        return;
      }

      // Шаг 2: Если время изменилось (или это первая загрузка), качаем данные
      setLoading(true);
      
      const [tagsRes, newsRes] = await Promise.all([
        fetch(`${API_BASE}/tags`),
        fetch(`${API_BASE}/news?days=${days}`)
      ]);

      const tagsData = await tagsRes.json();
      const newsFeatureCollection = await newsRes.json();

      setAvailableTags(tagsData);
      setNews(newsFeatureCollection.features);
      
      // Запоминаем новую метку времени
      setLastTimestamp(checkData.last_update);
      setLoading(false);
    } catch (err) {
      console.error("Ошибка синхронизации:", err);
      setLoading(false);
    }
  }, [days, lastTimestamp]); // Важно добавить lastTimestamp в список зависимостей

  useEffect(() => {
    loadData();
    // Обновление раз в 1 минуту, т.к. теперь не нагружает сервер
    const interval = setInterval(loadData, 1 *60* 1000);
    return () => clearInterval(interval);
  }, [loadData, days]);


  // Применение фильтров к отображаемым данным
  useEffect(() => {
    if (!news) return;

    // Локальная фильтрация по чекбоксами и тегам
    const filteredFeatures = news.filter(f => {
      const sentiment = (f.properties.sentiment || "NEUTRAL").toUpperCase();
      if (!sentimentFilters[sentiment]) return false;

      if (selectedTags.length > 0) {
        const featureTags = f.properties.tags || [];
        const matchesTag = selectedTags.some(tag => featureTags.includes(tag));
        if (!matchesTag) return false;
      }

      return true;
    });

    const format = new GeoJSON();
    const olFeatures = format.readFeatures({
      type: "FeatureCollection",
      features: filteredFeatures
    });
    
    vectorSourceRef.current.clear();
    vectorSourceRef.current.addFeatures(olFeatures);

  }, [news, sentimentFilters, selectedTags]);

  // Инициализация карты
  useEffect(() => {
    if (mapRef.current) return; // уже инициализирована

    // Создаем кластерный источник
    const clusterSource = new Cluster({
      distance: 60, // Радиус объединения
      source: vectorSourceRef.current
    });

    // Создаем векторный слой
    const vectorLayer = new VectorLayer({
      source: clusterSource,
      style: getClusterStyle,
      zIndex: 10
    });vectorLayerRef.current = vectorLayer;

    // Создаем Overlay для всплывающего окна
    popupOverlay.current = new Overlay({
      element: popupElement.current,
      positioning: 'bottom-center',
      stopEvent: true,
      offset: [0, -20]
    });

    // Инициализация OpenLayers Map
    const initialMap = new Map({
      target: mapElement.current,
      layers: [
        // Стандартная подложка OpenStreetMap
        new TileLayer({
          source: new OSM()
        }),
        vectorLayer
      ],
      view: new View({
        center: [90, 60], // Центр на РФ
        zoom: 3.5,
        minZoom: 4,
        maxZoom: 15
      }),
      overlays: [popupOverlay.current]
    });

    // Обработка клика
    initialMap.on('singleclick', (evt) => {
      const feature = initialMap.forEachFeatureAtPixel(evt.pixel, f => f);
      
      if (feature && feature.get('features')) {
        const subFeatures = feature.get('features');
        const propsArr = subFeatures.map(f => f.getProperties());
        const coord = feature.getGeometry().getCoordinates();
        
        setSelectedCluster(propsArr);
        popupOverlay.current.setPosition(coord);
      } else {
        // Закрываем попап
        popupOverlay.current.setPosition(undefined);
        setSelectedCluster(null);
      }
    });

    // Изменение курсора при наведении
    initialMap.on('pointermove', (e) => {
      if (e.dragging) return;
      const pixel = initialMap.getEventPixel(e.originalEvent);
      const hit = initialMap.hasFeatureAtPixel(pixel);
      initialMap.getTargetElement().style.cursor = hit ? 'pointer' : '';
    });

    mapRef.current = initialMap;

    return () => {
      initialMap.setTarget(undefined);
      mapRef.current = null;
    };
  }, []);

  // Хендлеры фильтров
  const toggleSentiment = (key) => {
    setSentimentFilters(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const toggleTag = (tag) => {
    setSelectedTags(prev => 
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  };

  return (
    <>
      {loading && (
        <div className="loading-overlay">
          <div className="loader"></div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', letterSpacing: '1px' }}>
            СИНХРОНИЗАЦИЯ БАЗЫ...
          </div>
        </div>
      )}

      {/* Карта */}
      <div ref={mapElement} className="map-container" />

      {/* Панель фильтров (Glassmorphism) */}
      <div className="filter-panel">
        <h2 className="panel-title">Мониторинг новостей УФО</h2>
        
        {/* Фильтр по времени */}
        <div className="filter-section">
          <span className="filter-label">Период анализа</span>
          <select value={days} onChange={e => setDays(Number(e.target.value))}>
            <option value={1}>За 24 часа (вчера и сегодня)</option>
            <option value={5}>За 5 дней</option>
            <option value={30}>За месяц</option>
            <option value={90}>За 3 месяца</option>
          </select>
        </div>

        {/* Фильтр по тональности */}
        <div className="filter-section">
          <span className="filter-label">Тональность новостей</span>
          <div className="checkbox-group">
            <label className="checkbox-label">
              <input type="checkbox" checked={sentimentFilters.POSITIVE} onChange={() => toggleSentiment('POSITIVE')} />
              Позитивная <span style={{color: COLORS.POSITIVE}}>●</span>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={sentimentFilters.NEGATIVE} onChange={() => toggleSentiment('NEGATIVE')} />
              Негативная <span style={{color: COLORS.NEGATIVE}}>●</span>
            </label>
            <label className="checkbox-label">
              <input type="checkbox" checked={sentimentFilters.NEUTRAL} onChange={() => toggleSentiment('NEUTRAL')} />
              Нейтральная <span style={{color: COLORS.NEUTRAL}}>●</span>
            </label>
          </div>
        </div>
        
      <div className="filter-section">
        <label className="section-label">Метод оценки кластера</label>
        <div className="method-toggle">
          <button 
            className={`method-btn ${calcMethod === 'simple' ? 'active' : ''}`}
            onClick={() => setCalcMethod('simple')}
          >
            Средний эмоциональный фон.
          </button>
          <button 
            className={`method-btn ${calcMethod === 'weighted' ? 'active' : ''}`}
            onClick={() => setCalcMethod('weighted')}
          >
            Взвешенный индекс тональности
          </button>
        </div>
      </div>

        {/* Фильтр по тегам */}
        <div className="filter-section" style={{ flex: 1 }}>
          <span className="filter-label">Тематические  теги</span>
          <div className="tags-container">
            {availableTags.slice(0, 15).map(tag => (
              <span 
                key={tag} 
                className={`tag-badge ${selectedTags.includes(tag) ? 'active' : ''}`}
                onClick={() => toggleTag(tag)}
              >
                #{tag}
              </span>
            ))}
          </div>
          {availableTags.length === 0 && !loading && (
            <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Тегов пока нет...</span>
          )}
        </div>
      </div>

      {/* Всплывающее окно карточки новости */}
      <div 
        ref={popupElement} 
        className={`ol-popup ${selectedCluster ? 'visible' : ''}`}
        style={{ padding: '0', maxHeight: '400px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}
      >
        {selectedCluster && (
          <>
            <div style={{position: 'sticky', top: 0, borderTopLeftRadius: '16px', borderTopRightRadius: '16px', background: 'var(--panel-bg)', padding: '12px 20px', borderBottom: '1px solid var(--panel-border)', zIndex: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
              <h3 style={{fontSize: '1rem', margin: 0, fontWeight: 600}}>Записей: {selectedCluster.length}</h3>
              <button className="popup-close" style={{position: 'static'}} onClick={() => {
                popupOverlay.current.setPosition(undefined);
                setSelectedCluster(null);
              }}>×</button>
            </div>
            
            <div style={{padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: '20px'}}>
              {selectedCluster.slice(0, 10).map((pt, i) => (
                <div key={i} style={{borderBottom: i !== Math.min(selectedCluster.length, 10) - 1 ? '1px solid rgba(255,255,255,0.1)' : 'none', paddingBottom: '12px'}}>
                  <div className={`popup-sentiment sentiment-${(pt.sentiment || "NEUTRAL").toLowerCase()}`}>
                    {pt.sentiment === 'POSITIVE' ? 'Позитивная' :
                      pt.sentiment === 'NEGATIVE' ? 'Негативная' : 'Нейтральная'}
                  </div>
                  
                  <h3 className="popup-title" style={{fontSize: '1rem'}}>{pt.title}</h3>
                  
                  <div className="popup-meta" style={{margin: '8px 0'}}>
                    <span>{new Date(pt.date).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                    <span>📍 {pt.place_name}</span>
                  </div>
                  
                  <p style={{ fontSize: '0.85rem', color: '#cbd5e1', lineHeight: '1.4', marginBottom: '8px' }}>
                    {pt.text_preview}
                  </p>

                  <a href={pt.url} target="_blank" rel="noreferrer" className="popup-link" style={{marginTop: 0}}>
                    Читать в источнике →
                  </a>
                </div>
              ))}
              {selectedCluster.length > 10 && (
                <div style={{textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.8rem'}}>и еще {selectedCluster.length - 10} ...</div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default App;
