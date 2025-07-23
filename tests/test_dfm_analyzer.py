import unittest
from dfm_analyzer import DFMAnalyzer

class AnalyzerSmokeTest(unittest.TestCase):
    def test_instance_creation(self):
        analyzer = DFMAnalyzer()
        self.assertIsNotNone(analyzer)
