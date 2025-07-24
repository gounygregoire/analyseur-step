"""
Système de recommandation de matériaux plastiques pour injection
Basé sur les réponses au questionnaire utilisateur et l'analyse DFM
"""

from dataclasses import dataclass
from typing import List, Dict, Any
import json

@dataclass
class MaterialRecommendation:
    """Recommandation de matériau avec propriétés et justification"""
    name: str
    category: str
    description: str
    properties: Dict[str, Any]
    advantages: List[str]
    limitations: List[str]
    typical_applications: List[str]
    cost_level: str  # 'economy', 'balanced', 'premium'
    processing_notes: str
    score: float  # Score de compatibilité 0-100

class MaterialRecommendationEngine:
    """Moteur de recommandation de matériaux plastiques"""
    
    def __init__(self):
        self.materials_database = self._initialize_materials_database()
    
    def _initialize_materials_database(self):
        """Base de données complète des matériaux plastiques"""
        return {
            # Polyoléfines
            "PP": {
                "name": "Polypropylène (PP)",
                "category": "Polyoléfine",
                "description": "Thermoplastique polyvalent, léger et résistant chimiquement",
                "properties": {
                    "density": 0.91,
                    "temp_service_max": 100,
                    "temp_service_min": -20,
                    "impact_resistance": "moyenne",
                    "chemical_resistance": "excellente",
                    "transparency": "opaque",
                    "cost": "économique"
                },
                "advantages": [
                    "Excellente résistance chimique",
                    "Très bon rapport qualité/prix",
                    "Recyclable",
                    "Faible densité",
                    "Bonne résistance à la fatigue",
                    "Aptitude au soudage"
                ],
                "limitations": [
                    "Sensible aux UV sans additifs",
                    "Température de service limitée",
                    "Rigidité moyenne"
                ],
                "typical_applications": [
                    "Emballages alimentaires",
                    "Pièces automobiles",
                    "Électroménager",
                    "Mobilier extérieur",
                    "Contenants"
                ],
                "processing_notes": "Excellente fluidité, cycles courts, faible retrait"
            },
            
            "PE-HD": {
                "name": "Polyéthylène Haute Densité (PE-HD)",
                "category": "Polyoléfine",
                "description": "Plastique robuste avec excellente résistance chimique",
                "properties": {
                    "density": 0.96,
                    "temp_service_max": 80,
                    "temp_service_min": -40,
                    "impact_resistance": "très bonne",
                    "chemical_resistance": "excellente",
                    "transparency": "opaque",
                    "cost": "économique"
                },
                "advantages": [
                    "Résistance exceptionnelle aux chocs",
                    "Inerte chimiquement",
                    "Contact alimentaire",
                    "Très économique",
                    "Résistant au gel"
                ],
                "limitations": [
                    "Température de service limitée",
                    "Sensible aux contraintes",
                    "Adhésion difficile"
                ],
                "typical_applications": [
                    "Réservoirs",
                    "Tuyauterie",
                    "Jouets",
                    "Contenants alimentaires",
                    "Bacs industriels"
                ],
                "processing_notes": "Nécessite des températures élevées, attention au retrait"
            },

            # Styréniques
            "PS": {
                "name": "Polystyrène (PS)",
                "category": "Styrénique",
                "description": "Plastique rigide transparent, facile à transformer",
                "properties": {
                    "density": 1.05,
                    "temp_service_max": 70,
                    "temp_service_min": -10,
                    "impact_resistance": "faible",
                    "chemical_resistance": "limitée",
                    "transparency": "excellente",
                    "cost": "économique"
                },
                "advantages": [
                    "Excellente transparence",
                    "Très économique",
                    "Facilité de transformation",
                    "Finition de surface excellente",
                    "Rigidité élevée"
                ],
                "limitations": [
                    "Fragile aux chocs",
                    "Sensible aux solvants",
                    "Température de service faible"
                ],
                "typical_applications": [
                    "Emballages transparents",
                    "Gobelets jetables",
                    "Boîtiers électroniques",
                    "Articles de bureau",
                    "Jouets rigides"
                ],
                "processing_notes": "Très fluide, cycles rapides, attention aux contraintes"
            },

            "ABS": {
                "name": "Acrylonitrile Butadiène Styrène (ABS)",
                "category": "Styrénique",
                "description": "Plastique technique équilibré, résistant et facile à décorer",
                "properties": {
                    "density": 1.05,
                    "temp_service_max": 85,
                    "temp_service_min": -40,
                    "impact_resistance": "très bonne",
                    "chemical_resistance": "moyenne",
                    "transparency": "opaque",
                    "cost": "équilibré"
                },
                "advantages": [
                    "Excellente résistance aux chocs",
                    "Facilité de décoration",
                    "Bon compromis propriétés/prix",
                    "Usinabilité excellente",
                    "Bonne stabilité dimensionnelle"
                ],
                "limitations": [
                    "Sensible aux UV",
                    "Résistance chimique limitée",
                    "Température de service modérée"
                ],
                "typical_applications": [
                    "Électroménager",
                    "Automobile (intérieur)",
                    "Électronique grand public",
                    "Jouets techniques",
                    "Valises, bagages"
                ],
                "processing_notes": "Fluide à chaud, bon état de surface, séchage nécessaire"
            },

            # Polyamides
            "PA6": {
                "name": "Polyamide 6 (Nylon 6)",
                "category": "Polyamide",
                "description": "Plastique technique haute performance, résistant à l'usure",
                "properties": {
                    "density": 1.14,
                    "temp_service_max": 150,
                    "temp_service_min": -40,
                    "impact_resistance": "excellente",
                    "chemical_resistance": "bonne",
                    "transparency": "translucide",
                    "cost": "premium"
                },
                "advantages": [
                    "Résistance mécanique exceptionnelle",
                    "Excellente résistance à l'usure",
                    "Température de service élevée",
                    "Bonne résistance à la fatigue",
                    "Auto-lubrifiant"
                ],
                "limitations": [
                    "Absorption d'humidité",
                    "Coût élevé",
                    "Retrait important",
                    "Sensible aux acides"
                ],
                "typical_applications": [
                    "Engrenages, roulements",
                    "Pièces automobiles moteur",
                    "Connecteurs électriques",
                    "Textiles techniques",
                    "Équipements sportifs"
                ],
                "processing_notes": "Séchage obligatoire, température élevée, injection rapide"
            },

            "PA66": {
                "name": "Polyamide 66 (Nylon 66)",
                "category": "Polyamide",
                "description": "Polyamide technique haute performance avec rigidité supérieure",
                "properties": {
                    "density": 1.15,
                    "temp_service_max": 160,
                    "temp_service_min": -40,
                    "impact_resistance": "excellente",
                    "chemical_resistance": "bonne",
                    "transparency": "translucide",
                    "cost": "premium"
                },
                "advantages": [
                    "Rigidité supérieure au PA6",
                    "Stabilité thermique excellente",
                    "Résistance chimique améliorée",
                    "Précision dimensionnelle",
                    "Tenue en fatigue"
                ],
                "limitations": [
                    "Plus coûteux que PA6",
                    "Absorption d'humidité",
                    "Transformation plus délicate",
                    "Retrait anisotrope"
                ],
                "typical_applications": [
                    "Sous le capot automobile",
                    "Connecteurs haute température",
                    "Pièces mécaniques précises",
                    "Outillage industriel",
                    "Équipements électriques"
                ],
                "processing_notes": "Séchage critique, hautes températures, moules chauds"
            },

            # Polyesters
            "PET": {
                "name": "Polyéthylène téréphtalate (PET)",
                "category": "Polyester",
                "description": "Plastique transparent avec excellentes propriétés barrière",
                "properties": {
                    "density": 1.38,
                    "temp_service_max": 120,
                    "temp_service_min": -40,
                    "impact_resistance": "bonne",
                    "chemical_resistance": "très bonne",
                    "transparency": "excellente",
                    "cost": "équilibré"
                },
                "advantages": [
                    "Transparence cristalline",
                    "Excellentes propriétés barrière",
                    "Contact alimentaire",
                    "Résistance chimique",
                    "100% recyclable"
                ],
                "limitations": [
                    "Sensible à l'hydrolyse",
                    "Séchage obligatoire",
                    "Cristallisation lente"
                ],
                "typical_applications": [
                    "Bouteilles alimentaires",
                    "Emballages pharmaceutiques",
                    "Films et fibres",
                    "Pièces électroniques",
                    "Containers micro-ondables"
                ],
                "processing_notes": "Séchage critique, contrôle cristallisation, injection chaude"
            },

            # Polycarbonates
            "PC": {
                "name": "Polycarbonate (PC)",
                "category": "Polycarbonate",
                "description": "Plastique technique transparent haute performance",
                "properties": {
                    "density": 1.20,
                    "temp_service_max": 140,
                    "temp_service_min": -100,
                    "impact_resistance": "exceptionnelle",
                    "chemical_resistance": "moyenne",
                    "transparency": "excellente",
                    "cost": "premium"
                },
                "advantages": [
                    "Résistance aux chocs exceptionnelle",
                    "Transparence optique",
                    "Large plage de température",
                    "Résistance aux UV",
                    "Propriétés électriques"
                ],
                "limitations": [
                    "Coût élevé",
                    "Sensible aux contraintes",
                    "Sensible aux bases",
                    "Rayures facilement"
                ],
                "typical_applications": [
                    "Écrans, vitres de sécurité",
                    "Boîtiers électroniques",
                    "Optique (CD, lunettes)",
                    "Médical",
                    "Automobile (phares)"
                ],
                "processing_notes": "Séchage obligatoire, hautes températures, éviter les contraintes"
            },

            # POM
            "POM": {
                "name": "Polyoxyméthylène (POM)",
                "category": "Acétal",
                "description": "Plastique technique de précision avec excellente stabilité dimensionnelle",
                "properties": {
                    "density": 1.42,
                    "temp_service_max": 120,
                    "temp_service_min": -40,
                    "impact_resistance": "bonne",
                    "chemical_resistance": "excellente",
                    "transparency": "opaque",
                    "cost": "premium"
                },
                "advantages": [
                    "Stabilité dimensionnelle exceptionnelle",
                    "Excellente résistance chimique",
                    "Faible coefficient de friction",
                    "Résistance à la fatigue",
                    "Précision dimensionnelle"
                ],
                "limitations": [
                    "Sensible aux acides forts",
                    "Coût élevé",
                    "Dégagement de formaldéhyde",
                    "Colorabilité limitée"
                ],
                "typical_applications": [
                    "Engrenages de précision",
                    "Pièces automobiles",
                    "Connecteurs électriques",
                    "Robinetterie",
                    "Mécanismes d'horlogerie"
                ],
                "processing_notes": "Injection rapide, température contrôlée, éviter la surchauffe"
            },

            # TPU
            "TPU": {
                "name": "Polyuréthane thermoplastique (TPU)",
                "category": "Élastomère",
                "description": "Plastique souple haute performance, élastique et résistant",
                "properties": {
                    "density": 1.20,
                    "temp_service_max": 80,
                    "temp_service_min": -50,
                    "impact_resistance": "exceptionnelle",
                    "chemical_resistance": "bonne",
                    "transparency": "possible",
                    "cost": "premium"
                },
                "advantages": [
                    "Flexibilité exceptionnelle",
                    "Résistance à l'abrasion",
                    "Élasticité durable",
                    "Adhérence excellent",
                    "Large gamme de duretés"
                ],
                "limitations": [
                    "Coût élevé",
                    "Sensible à l'hydrolyse",
                    "Transformation délicate",
                    "Fluage sous contrainte"
                ],
                "typical_applications": [
                    "Semelles, articles de sport",
                    "Gaines et soufflets",
                    "Pièces automobiles flexibles",
                    "Étuis de protection",
                    "Joints et garnitures"
                ],
                "processing_notes": "Séchage critique, températures modérées, cycles longs"
            }
        }
    
    def recommend_materials(self, questionnaire_data: Dict[str, Any], dfm_data: Dict[str, Any] = None) -> List[MaterialRecommendation]:
        """
        Recommande 3 matériaux basés sur le questionnaire et l'analyse DFM
        """
        # Calculer les scores pour tous les matériaux
        material_scores = {}
        
        for material_id, material_data in self.materials_database.items():
            score = self._calculate_material_score(material_id, material_data, questionnaire_data, dfm_data)
            material_scores[material_id] = score
        
        # Trier par score décroissant et prendre les 3 meilleurs
        sorted_materials = sorted(material_scores.items(), key=lambda x: x[1], reverse=True)
        top_3_materials = sorted_materials[:3]
        
        # Créer les objets de recommandation
        recommendations = []
        for material_id, score in top_3_materials:
            material_data = self.materials_database[material_id]
            recommendation = MaterialRecommendation(
                name=material_data["name"],
                category=material_data["category"],
                description=material_data["description"],
                properties=material_data["properties"],
                advantages=material_data["advantages"],
                limitations=material_data["limitations"],
                typical_applications=material_data["typical_applications"],
                cost_level=material_data["properties"]["cost"],
                processing_notes=material_data["processing_notes"],
                score=score
            )
            recommendations.append(recommendation)
        
        return recommendations
    
    def _calculate_material_score(self, material_id: str, material_data: Dict[str, Any], 
                                questionnaire_data: Dict[str, Any], dfm_data: Dict[str, Any] = None) -> float:
        """
        Calcule un score de compatibilité pour un matériau donné
        """
        score = 0.0
        max_score = 0.0
        
        # Score basé sur l'application (25 points)
        application_score = self._score_application_fit(material_data, questionnaire_data.get('application', ''))
        score += application_score
        max_score += 25
        
        # Score basé sur les contraintes mécaniques (25 points)
        mechanical_score = self._score_mechanical_requirements(material_data, questionnaire_data.get('mechanical', []))
        score += mechanical_score
        max_score += 25
        
        # Score basé sur l'environnement (20 points)
        environment_score = self._score_environment_fit(material_data, questionnaire_data)
        score += environment_score
        max_score += 20
        
        # Score basé sur les exigences esthétiques (10 points)
        aesthetic_score = self._score_aesthetic_requirements(material_data, questionnaire_data.get('aesthetic', []))
        score += aesthetic_score
        max_score += 10
        
        # Score basé sur les contraintes réglementaires (10 points)
        regulatory_score = self._score_regulatory_requirements(material_data, questionnaire_data.get('regulatory', []))
        score += regulatory_score
        max_score += 10
        
        # Score basé sur le coût (10 points)
        cost_score = self._score_cost_fit(material_data, questionnaire_data.get('cost', 'balanced'))
        score += cost_score
        max_score += 10
        
        # Bonus/malus basé sur l'analyse DFM si disponible
        if dfm_data:
            dfm_bonus = self._score_dfm_compatibility(material_data, dfm_data)
            score += dfm_bonus
            max_score += 5
        
        # Normaliser le score sur 100
        final_score = (score / max_score) * 100 if max_score > 0 else 0
        return round(final_score, 1)
    
    def _score_application_fit(self, material_data: Dict[str, Any], application: str) -> float:
        """Score basé sur l'adéquation avec le domaine d'application"""
        application_mapping = {
            'automotive': ['PP', 'ABS', 'PA6', 'PA66', 'POM', 'PC'],
            'electronics': ['ABS', 'PC', 'POM', 'PA66', 'PET'],
            'medical': ['PC', 'PET', 'PE-HD', 'PP', 'TPU'],
            'packaging': ['PP', 'PE-HD', 'PET', 'PS'],
            'consumer': ['ABS', 'PS', 'PP', 'PC', 'PE-HD'],
            'industrial': ['PA6', 'PA66', 'POM', 'PC', 'PP'],
            'aerospace': ['PC', 'PA66', 'POM', 'PET'],
            'toys': ['PP', 'ABS', 'PE-HD', 'PS', 'TPU']
        }
        
        # Retrouver le material_id
        material_name = material_data["name"]
        material_id = None
        for mid, mdata in self.materials_database.items():
            if mdata["name"] == material_name:
                material_id = mid
                break
        
        if application in application_mapping and material_id in application_mapping[application]:
            # Position dans la liste = priorité (premier = meilleur)
            position = application_mapping[application].index(material_id)
            return 25 - (position * 3)  # Score décroissant selon la position
        
        return 10  # Score de base si pas dans la liste prioritaire
    
    def _score_mechanical_requirements(self, material_data: Dict[str, Any], mechanical_requirements: List[str]) -> float:
        """Score basé sur les exigences mécaniques"""
        if not mechanical_requirements:
            return 15  # Score neutre
        
        score = 0
        properties = material_data["properties"]
        
        for requirement in mechanical_requirements:
            if requirement == 'impact' and properties.get('impact_resistance') in ['très bonne', 'excellente', 'exceptionnelle']:
                score += 4
            elif requirement == 'stiffness' and properties.get('density', 0) > 1.1:  # Matériaux plus denses = plus rigides
                score += 3
            elif requirement == 'flexibility' and properties.get('impact_resistance') in ['très bonne', 'excellente', 'exceptionnelle']:
                score += 3
            elif requirement == 'wear' and material_data["category"] in ['Polyamide', 'Acétal']:
                score += 4
            elif requirement == 'tensile' and material_data["category"] in ['Polyamide', 'Polycarbonate']:
                score += 3
            elif requirement == 'fatigue' and material_data["category"] in ['Polyamide', 'Acétal', 'Polyoléfine']:
                score += 3
            elif requirement == 'creep' and material_data["category"] in ['Polyamide', 'Acétal', 'Polycarbonate']:
                score += 4
        
        return min(score, 25)  # Plafonner à 25 points
    
    def _score_environment_fit(self, material_data: Dict[str, Any], questionnaire_data: Dict[str, Any]) -> float:
        """Score basé sur l'environnement d'usage"""
        score = 0
        properties = material_data["properties"]
        
        # Température
        temp_range = questionnaire_data.get('temperature', 'ambient')
        temp_max = properties.get('temp_service_max', 50)
        
        if temp_range == 'low' and properties.get('temp_service_min', 0) <= -30:
            score += 5
        elif temp_range == 'ambient':
            score += 5  # Tous les matériaux conviennent
        elif temp_range == 'elevated' and temp_max >= 60:
            score += 5
        elif temp_range == 'high' and temp_max >= 100:
            score += 5
        elif temp_range == 'extreme' and temp_max >= 140:
            score += 5
        
        # Exposition
        exposures = questionnaire_data.get('exposure', [])
        for exposure in exposures:
            if exposure == 'uv' and properties.get('chemical_resistance') == 'excellente':
                score += 3
            elif exposure == 'humidity' and material_data["category"] in ['Polyoléfine', 'Styrénique']:
                score += 3
            elif exposure == 'chemicals' and properties.get('chemical_resistance') in ['très bonne', 'excellente']:
                score += 4
        
        return min(score, 20)
    
    def _score_aesthetic_requirements(self, material_data: Dict[str, Any], aesthetic_requirements: List[str]) -> float:
        """Score basé sur les exigences esthétiques"""
        if not aesthetic_requirements:
            return 5  # Score neutre
        
        score = 0
        properties = material_data["properties"]
        
        for requirement in aesthetic_requirements:
            if requirement == 'transparent' and properties.get('transparency') == 'excellente':
                score += 3
            elif requirement == 'colored' and material_data["category"] in ['Polyoléfine', 'Styrénique', 'Polyamide']:
                score += 2
            elif requirement == 'gloss' and material_data["category"] in ['Styrénique', 'Polycarbonate']:
                score += 2
            elif requirement == 'surface' and material_data["category"] in ['Styrénique', 'Polycarbonate', 'Acétal']:
                score += 2
            elif requirement == 'texture':
                score += 1  # Tous matériaux peuvent être texturés
            elif requirement == 'printing' and material_data["category"] in ['Polyoléfine', 'Styrénique']:
                score += 2
        
        return min(score, 10)
    
    def _score_regulatory_requirements(self, material_data: Dict[str, Any], regulatory_requirements: List[str]) -> float:
        """Score basé sur les contraintes réglementaires"""
        if not regulatory_requirements:
            return 5  # Score neutre
        
        score = 0
        material_name = material_data["name"]
        
        for requirement in regulatory_requirements:
            if requirement == 'food_contact' and any(mat in material_name for mat in ['PP', 'PE', 'PET']):
                score += 3
            elif requirement == 'medical_grade' and any(mat in material_name for mat in ['PC', 'PET', 'PE']):
                score += 3
            elif requirement == 'flame_retardant' and any(mat in material_name for mat in ['PC', 'PA66', 'POM']):
                score += 3
            elif requirement == 'electrical' and any(mat in material_name for mat in ['PC', 'PA66', 'POM', 'ABS']):
                score += 2
        
        return min(score, 10)
    
    def _score_cost_fit(self, material_data: Dict[str, Any], cost_preference: str) -> float:
        """Score basé sur la contrainte de coût"""
        material_cost = material_data["properties"].get("cost", "équilibré")
        
        cost_matrix = {
            'economy': {'économique': 10, 'équilibré': 6, 'premium': 2},
            'balanced': {'économique': 8, 'équilibré': 10, 'premium': 6},
            'premium': {'économique': 4, 'équilibré': 7, 'premium': 10}
        }
        
        return cost_matrix.get(cost_preference, {}).get(material_cost, 5)
    
    def _score_dfm_compatibility(self, material_data: Dict[str, Any], dfm_data: Dict[str, Any]) -> float:
        """Bonus/malus basé sur l'analyse DFM"""
        score = 0
        
        # Si analyse DFM critique, privilégier matériaux faciles à injecter
        dfm_rating = dfm_data.get('overall_rating', 'good')
        if dfm_rating == 'critical':
            # Privilégier matériaux fluides (PP, PS, ABS)
            if material_data["category"] in ['Polyoléfine', 'Styrénique']:
                score += 3
        
        # Si parois fines détectées, privilégier matériaux fluides
        wall_issues = dfm_data.get('wall_thickness_issues', [])
        thin_walls = any(issue.get('issue_type') == 'too_thin' for issue in wall_issues)
        if thin_walls:
            if material_data["category"] in ['Polyoléfine', 'Styrénique']:
                score += 2
        
        return score

def recommend_materials_for_questionnaire(questionnaire_data: Dict[str, Any], dfm_data: Dict[str, Any] = None) -> List[Dict[str, Any]]:
    """
    Fonction utilitaire pour recommander des matériaux
    """
    engine = MaterialRecommendationEngine()
    recommendations = engine.recommend_materials(questionnaire_data, dfm_data)
    
    # Convertir en dictionnaires pour la sérialisation JSON
    result = []
    for rec in recommendations:
        result.append({
            'name': rec.name,
            'category': rec.category,
            'description': rec.description,
            'properties': rec.properties,
            'advantages': rec.advantages,
            'limitations': rec.limitations,
            'typical_applications': rec.typical_applications,
            'cost_level': rec.cost_level,
            'processing_notes': rec.processing_notes,
            'score': rec.score
        })
    
    return result
