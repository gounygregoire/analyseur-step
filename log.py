"""
Système de logging des actions utilisateurs pour CADlytics
"""
import json
import os
from datetime import datetime
from threading import Lock

# Lock pour éviter les conflits d'écriture
log_lock = Lock()

# Fichier de log
LOG_FILE = 'analytics.json'

def log_action(action, user_id=None, extra=None):
    """
    Log une action utilisateur dans le fichier JSONL
    
    Args:
        action: Type d'action (upload, analyze, download, login, etc.)
        user_id: ID de l'utilisateur (optionnel)
        extra: Dictionnaire avec des données supplémentaires (optionnel)
    """
    log_entry = {
        'timestamp': datetime.utcnow().isoformat(),
        'action': action,
        'user_id': user_id
    }
    
    # Ajouter les données supplémentaires si présentes
    if extra:
        log_entry.update(extra)
    
    # Écrire dans le fichier avec un lock pour éviter les conflits
    with log_lock:
        try:
            with open(LOG_FILE, 'a', encoding='utf-8') as f:
                # Format JSONL : une ligne JSON par entrée
                f.write(json.dumps(log_entry, ensure_ascii=False) + '\n')
        except Exception as e:
            print(f"Erreur lors du logging: {e}")

def read_logs():
    """
    Lit tous les logs du fichier JSONL
    
    Returns:
        Liste des entrées de log
    """
    logs = []
    if os.path.exists(LOG_FILE):
        try:
            with open(LOG_FILE, 'r', encoding='utf-8') as f:
                for line in f:
                    if line.strip():
                        logs.append(json.loads(line))
        except Exception as e:
            print(f"Erreur lors de la lecture des logs: {e}")
    return logs

def get_stats():
    """
    Calcule les statistiques à partir des logs
    
    Returns:
        Dictionnaire avec les statistiques
    """
    logs = read_logs()
    from datetime import datetime, timedelta
    
    stats = {
        'total_uploads': 0,
        'total_analyses': 0,
        'total_downloads': 0,
        'total_logins': 0,
        'total_users': 0,
        'active_users_today': 0,
        'avg_session_duration': 0,
        'users': set(),
        'recent_activities': [],
        'top_users': []
    }
    
    today = datetime.utcnow().date()
    user_activities = {}
    active_users_today = set()
    
    for log in logs:
        action = log.get('action')
        
        if action == 'upload':
            stats['total_uploads'] += 1
        elif action == 'analyze':
            stats['total_analyses'] += 1
        elif action == 'download':
            stats['total_downloads'] += 1
        elif action == 'login':
            stats['total_logins'] += 1
        
        # Compter les utilisateurs uniques
        user_email = log.get('user_email')
        if user_email:
            stats['users'].add(user_email)
            
            # Tracker pour top users
            if user_email not in user_activities:
                user_activities[user_email] = {
                    'email': user_email,
                    'uploads': 0,
                    'analyses': 0,
                    'downloads': 0,
                    'last_activity': log.get('timestamp', '')
                }
            
            if action == 'upload':
                user_activities[user_email]['uploads'] += 1
            elif action == 'analyze':
                user_activities[user_email]['analyses'] += 1
            elif action == 'download':
                user_activities[user_email]['downloads'] += 1
            
            user_activities[user_email]['last_activity'] = log.get('timestamp', '')
        
        # Compter les utilisateurs actifs aujourd'hui
        try:
            log_date = datetime.fromisoformat(log.get('timestamp', '')).date()
            if log_date == today and user_email:
                active_users_today.add(user_email)
        except:
            pass
    
    # Obtenir les 20 dernières activités
    recent = logs[-20:] if logs else []
    stats['recent_activities'] = []
    for activity in reversed(recent):
        try:
            # Formater le timestamp
            timestamp = datetime.fromisoformat(activity.get('timestamp', ''))
            formatted_time = timestamp.strftime('%d/%m %H:%M')
            
            stats['recent_activities'].append({
                'action': activity.get('action', ''),
                'user_email': activity.get('user_email', ''),
                'filename': activity.get('original_filename', ''),
                'timestamp': formatted_time
            })
        except:
            pass
    
    # Top users (top 10 par nombre d'analyses)
    sorted_users = sorted(user_activities.values(), 
                         key=lambda x: x['analyses'], 
                         reverse=True)[:10]
    
    stats['top_users'] = []
    for user in sorted_users:
        try:
            # Formater la dernière activité
            last_activity = datetime.fromisoformat(user['last_activity'])
            formatted_last = last_activity.strftime('%d/%m %H:%M')
            user['last_activity'] = formatted_last
            stats['top_users'].append(user)
        except:
            user['last_activity'] = 'N/A'
            stats['top_users'].append(user)
    
    # Calculer les statistiques finales
    stats['total_users'] = len(stats['users'])
    stats['active_users_today'] = len(active_users_today)
    stats['avg_session_duration'] = 15  # Estimation fixe pour l'instant
    
    # Convertir le set en list pour la sérialisation
    stats['users'] = list(stats['users'])
    
    return stats