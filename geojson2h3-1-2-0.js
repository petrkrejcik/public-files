/*
 * Copyright 2018 Uber Technologies, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *         http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @module geojson2h3
 */

var FEATURE = 'Feature';
var FEATURE_COLLECTION = 'FeatureCollection';
var POLYGON = 'Polygon';
var MULTI_POLYGON = 'MultiPolygon';

// ----------------------------------------------------------------------------
// Private utilities

/**
 * Utility for efficient flattening of arrays. This mutates input,
 * flattening into the first array in the list.
 * @private
 * @param {String[][]} arrays Arrays to flatten
 * @return {String} Single array with all values from all input arrays
 */
function flatten(arrays) {
    var out = null;
    for (var i = 0; i < arrays.length; i++) {
        if (out !== null) {
            for (var j = 0; j < arrays[i].length; j++) {
                out.push(arrays[i][j]);
            }
        } else {
            out = arrays[i];
        }
    }
    return Array.from(new Set(out));
}

/**
 * Utility to compute the centroid of a polygon, based on @turf/centroid
 * @private
 * @param {Number[][][]} polygon     Polygon, as an array of loops
 * @return {Number[]} lngLat         Lng/lat centroid
 */
function centroid(polygon) {
    var lngSum = 0;
    var latSum = 0;
    var count = 0;
    var loop = polygon[0];
    for (var i = 0; i < loop.length; i++) {
        lngSum += loop[i][0];
        latSum += loop[i][1];
        count++;
    }
    return [lngSum / count, latSum / count];
}

/**
 * Convert a GeoJSON feature collection to a set of hexagons. Only hexagons whose centers
 * fall within the features will be included.
 * @private
 * @param  {Object} feature     GeoJSON FeatureCollection
 * @param  {Number} resolution  Resolution of hexagons, between 0 and 15
 * @return {String[]}           H3 indexes
 */
function featureCollectionToH3Set(featureCollection, resolution) {
    var features = featureCollection.features;
    if (!features) {
        throw new Error('No features found');
    }
    return flatten(features.map(function (feature) { return featureToH3Set(feature, resolution); }));
}

// ----------------------------------------------------------------------------
// Public API functions

/**
 * Convert a GeoJSON feature to a set of hexagons. *Only hexagons whose centers
 * fall within the feature will be included.* Note that conversion from GeoJSON
 * is lossy; the resulting hexagon set only approximately describes the original
 * shape, at a level of precision determined by the hexagon resolution.
 *
 * If the polygon is small in comparison with the chosen resolution, there may be
 * no cell whose center lies within it, resulting in an empty set. To fall back
 * to a single H3 cell representing the centroid of the polygon in this case, use
 * the `ensureOutput` option.
 *
 * ![featureToH3Set](./doc-files/featureToH3Set.png)
 * @static
 * @param  {Object} feature     Input GeoJSON: type must be either `Feature` or
 *                              `FeatureCollection`, and geometry type must be
 *                              either `Polygon` or `MultiPolygon`
 * @param  {Number} resolution  Resolution of hexagons, between 0 and 15
 * @param  {Object} [options]   Options
 * @param  {Boolean} [options.ensureOutput] Whether to ensure that at least one
 *                              cell is returned in the set
 * @return {String[]}           H3 indexes
 */
function featureToH3Set(feature, resolution, options) {
    if ( options === void 0 ) options = {};

    var type = feature.type;
    var geometry = feature.geometry;
    var geometryType = geometry && geometry.type;

    if (type === FEATURE_COLLECTION) {
        return featureCollectionToH3Set(feature, resolution);
    }

    if (type !== FEATURE) {
        throw new Error(("Unhandled type: " + type));
    }
    if (geometryType !== POLYGON && geometryType !== MULTI_POLYGON) {
        throw new Error(("Unhandled geometry type: " + geometryType));
    }

    // Normalize to MultiPolygon
    var polygons = geometryType === POLYGON ? [geometry.coordinates] : geometry.coordinates;

    // Polyfill each polygon and flatten the results
    return flatten(
        polygons.map(function (polygon) {
            var result = h3.polyfill(polygon, resolution, true);
            if (result.length || !options.ensureOutput) {
                return result;
            }
            // If we got no results, index the centroid
            var ref = centroid(polygon);
            var lng = ref[0];
            var lat = ref[1];
            return [h3.geoToH3(lat, lng, resolution)];
        })
    );
}

/**
 * Convert a single H3 hexagon to a `Polygon` feature
 * @static
 * @param  {String} hexAddress   Hexagon address
 * @param  {Object} [properties] Optional feature properties
 * @return {Feature}             GeoJSON Feature object
 */
function h3ToFeature(h3Index, properties) {
    if ( properties === void 0 ) properties = {};

    // Wrap in an array for a single-loop polygon
    var coordinates = [h3.h3ToGeoBoundary(h3Index, true)];
    return {
        type: FEATURE,
        id: h3Index,
        properties: properties,
        geometry: {
            type: POLYGON,
            coordinates: coordinates
        }
    };
}

/**
 * Convert a set of hexagons to a GeoJSON `Feature` with the set outline(s). The
 * feature's geometry type will be either `Polygon` or `MultiPolygon` depending on
 * the number of outlines required for the set.
 *
 * ![h3SetToFeature](./doc-files/h3SetToFeature.png)
 * @static
 * @param  {String[]} hexagons   Hexagon addresses
 * @param  {Object} [properties] Optional feature properties
 * @return {Feature}             GeoJSON Feature object
 */
function h3SetToFeature(hexagons, properties) {
    if ( properties === void 0 ) properties = {};

    var polygons = h3.h3SetToMultiPolygon(hexagons, true);
    // See if we can unwrap to a simple Polygon.
    var isMultiPolygon = polygons.length > 1;
    var type = isMultiPolygon ? MULTI_POLYGON : POLYGON;
    // MultiPolygon, single polygon, or empty array for an empty hex set
    var coordinates = isMultiPolygon ? polygons : polygons[0] || [];
    return {
        type: FEATURE,
        properties: properties,
        geometry: {
            type: type,
            coordinates: coordinates
        }
    };
}

/**
 * Convert a set of hexagons to a GeoJSON `MultiPolygon` feature with the
 * outlines of each individual hexagon.
 *
 * ![h3SetToMultiPolygonFeature](./doc-files/h3SetToFeatureCollection.png)
 * @static
 * @param  {String[]} hexagons   Hexagon addresses
 * @param  {Object} [properties] Optional feature properties
 * @return {Feature}             GeoJSON Feature object
 */
function h3SetToMultiPolygonFeature(hexagons, properties) {
    if ( properties === void 0 ) properties = {};

    var coordinates = hexagons.map(function (h3Index) { return [h3.h3ToGeoBoundary(h3Index, {geoJson: true})]; }
    );
    return {
        type: FEATURE,
        properties: properties,
        geometry: {
            type: MULTI_POLYGON,
            coordinates: coordinates
        }
    };
}

/**
 * Convert a set of hexagons to a GeoJSON `FeatureCollection` with each hexagon
 * in a separate `Polygon` feature with optional properties.
 *
 * ![h3SetToFeatureCollection](./doc-files/h3SetToFeatureCollection.png)
 * @static
 * @param  {String[]} hexagons  Hexagon addresses
 * @param  {Function} [getProperties] Optional function returning properties
 *                                    for a hexagon: f(h3Index) => Object
 * @return {FeatureCollection}        GeoJSON FeatureCollection object
 */
function h3SetToFeatureCollection(hexagons, getProperties) {
    var features = [];
    for (var i = 0; i < hexagons.length; i++) {
        var h3Index = hexagons[i];
        var properties = getProperties ? getProperties(h3Index) : {};
        features.push(h3ToFeature(h3Index, properties));
    }
    return {
        type: FEATURE_COLLECTION,
        features: features
    };
}

window.GeoJSON = {
    featureToH3Set: featureToH3Set,
    h3ToFeature: h3ToFeature,
    h3SetToFeature: h3SetToFeature,
    h3SetToMultiPolygonFeature: h3SetToMultiPolygonFeature,
    h3SetToFeatureCollection: h3SetToFeatureCollection
};
