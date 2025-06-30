from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.orm import DeclarativeBase
from flask_dance.consumer.storage.sqla import OAuthConsumerMixin
from flask_login import UserMixin
from sqlalchemy import UniqueConstraint
from datetime import datetime
import uuid

class Base(DeclarativeBase):
    pass

db = SQLAlchemy(model_class=Base)

class ConversionJob(db.Model):
    __tablename__ = 'conversion_jobs'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    original_filename = db.Column(db.String(255), nullable=False)
    step_filename = db.Column(db.String(255), nullable=False)
    stl_filename = db.Column(db.String(255), nullable=False)
    tolerance = db.Column(db.Float, nullable=False, default=0.1)
    step_file_size = db.Column(db.Integer, nullable=False)
    stl_file_size = db.Column(db.Integer, nullable=True)
    status = db.Column(db.String(20), nullable=False, default='processing')  # processing, completed, failed
    error_message = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    completed_at = db.Column(db.DateTime, nullable=True)
    
    # DFM Analysis fields
    dfm_score = db.Column(db.Integer, nullable=True)  # 1-10 moldability score
    dfm_issues_count = db.Column(db.Integer, nullable=True)  # Number of issues found
    dfm_overall_rating = db.Column(db.String(20), nullable=True)  # excellent, good, warning, critical
    
    def __repr__(self):
        return f'<ConversionJob {self.id}: {self.original_filename}>'
    
    def to_dict(self):
        return {
            'id': self.id,
            'original_filename': self.original_filename,
            'step_filename': self.step_filename,
            'stl_filename': self.stl_filename,
            'tolerance': self.tolerance,
            'step_file_size': self.step_file_size,
            'stl_file_size': self.stl_file_size,
            'status': self.status,
            'error_message': self.error_message,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'completed_at': self.completed_at.isoformat() if self.completed_at else None,
            'dfm_score': self.dfm_score,
            'dfm_issues_count': self.dfm_issues_count,
            'dfm_overall_rating': self.dfm_overall_rating
        }

class UserSession(db.Model):
    __tablename__ = 'user_sessions'
    
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    session_id = db.Column(db.String(255), nullable=False, unique=True)
    ip_address = db.Column(db.String(45), nullable=True)
    user_agent = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    last_activity = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    
    def __repr__(self):
        return f'<UserSession {self.session_id}>'

# Table utilisateur principale avec authentification email et OAuth
class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    email = db.Column(db.String(120), unique=True, nullable=False)
    password_hash = db.Column(db.String(256), nullable=True)  # Null pour OAuth
    first_name = db.Column(db.String(50), nullable=True)
    last_name = db.Column(db.String(50), nullable=True)
    profile_image_url = db.Column(db.String(255), nullable=True)
    
    # Gestion des crédits et abonnements
    credits = db.Column(db.Integer, default=0)  # Nombre d'analyses restantes
    is_premium = db.Column(db.Boolean, default=False)  # Abonné ou non
    stripe_customer_id = db.Column(db.String(255), nullable=True)
    stripe_subscription_id = db.Column(db.String(255), nullable=True)
    
    # OAuth providers
    google_id = db.Column(db.String(100), nullable=True, unique=True)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def has_access(self):
        """Vérifie si l'utilisateur peut faire une analyse"""
        return self.is_premium or self.credits > 0
    
    def use_credit(self):
        """Utilise un crédit si disponible"""
        if not self.is_premium and self.credits > 0:
            self.credits -= 1
            db.session.commit()
            return True
        return self.is_premium

# Table OAuth pour stocker les tokens d'authentification
class OAuth(OAuthConsumerMixin, db.Model):
    user_id = db.Column(db.String, db.ForeignKey(User.id))
    browser_session_key = db.Column(db.String, nullable=False)
    user = db.relationship(User)

    __table_args__ = (UniqueConstraint(
        'user_id',
        'browser_session_key',
        'provider',
        name='uq_user_browser_session_key_provider',
    ),)