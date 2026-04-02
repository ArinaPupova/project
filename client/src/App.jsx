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

useGeographic(); // Упрощает работу с координатами (оставляем Lon, Lat)

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

  // Загрузка данных
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      // Загружаем теги
      const tagsRes = await fetch(`${API_BASE}/tags`);
      const tagsData = await tagsRes.json();
      setAvailableTags(tagsData);

      // Загружаем новости с учетом фильтра дней
      const newsRes = await fetch(`${API_BASE}/news?days=${days}`);
      const newsFeatureCollection = await newsRes.json();
      setNews(newsFeatureCollection.features);

      setLoading(false);
    } catch (err) {
      console.error("Ошибка загрузки данных:", err);
      setLoading(false);
    }
  }, [days]);

  useEffect(() => {
    loadData();
    // Обновление раз в 5 минут (чтобы не перегружать)
    const interval = setInterval(loadData, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadData]);


  // Применение фильтров к отображаемым данным
  useEffect(() => {
    if (!news) return;

    // Локальная фильтрация по чекбоксами и тегам (чтобы не трогать бэкенд каждый клик)
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
      style: clusterStyleFunction,
      zIndex: 10
    });

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
        minZoom: 2,
        maxZoom: 18
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
                    {(pt.sentiment || "NEUTRAL").toUpperCase()} ({pt.confidence ? pt.confidence.toFixed(2) : "N/A"})
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
