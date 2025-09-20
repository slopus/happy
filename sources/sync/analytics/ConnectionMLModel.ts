/**
 * Machine Learning Model for Connection Optimization
 * Uses linear regression for optimal parameter prediction
 */

export class ConnectionMLModel {
  private weights: Map<string, number> = new Map();
  private trainingData: Array<{ features: number[]; target: number }> = [];
  private learningRate = 0.01;
  private predictions: Array<{ predicted: number; actual: number }> = [];

  constructor() {
    // Initialize default weights
    this.weights.set('latency', -0.1);
    this.weights.set('successRate', 1.0);
    this.weights.set('networkQuality', 0.5);
    this.weights.set('timeOfDay', 0.1);
  }

  train(features: number[], target: number): void {
    // Store training data for batch processing
    this.trainingData.push({ features: [...features], target });

    // Perform simple gradient descent
    this.performGradientDescent(features, target);

    // Keep only recent training data (rolling window)
    if (this.trainingData.length > 1000) {
      this.trainingData = this.trainingData.slice(-500);
    }
  }

  private performGradientDescent(features: number[], target: number): void {
    const prediction = this.predict(features);
    const error = target - prediction;

    // Update weights based on error
    const featureNames = ['latency', 'successRate', 'networkQuality', 'timeOfDay'];
    features.forEach((feature, index) => {
      if (index < featureNames.length) {
        const currentWeight = this.weights.get(featureNames[index]) || 0;
        const newWeight = currentWeight + this.learningRate * error * feature;
        this.weights.set(featureNames[index], newWeight);
      }
    });
  }

  predict(features: number[]): number {
    if (features.length === 0) return 30000; // Default heartbeat

    let prediction = 5000; // Base prediction
    const featureNames = ['latency', 'successRate', 'networkQuality', 'timeOfDay'];

    features.forEach((feature, index) => {
      if (index < featureNames.length) {
        const weight = this.weights.get(featureNames[index]) || 0;
        prediction += weight * feature;
      }
    });

    // Clamp to reasonable range
    return Math.max(5000, Math.min(60000, prediction));
  }

  recordPredictionAccuracy(predicted: number, actual: number): void {
    this.predictions.push({ predicted, actual });
    // Keep only recent predictions for accuracy calculation
    if (this.predictions.length > 100) {
      this.predictions = this.predictions.slice(-50);
    }
  }

  getAccuracy(): number {
    if (this.predictions.length < 10) return 0;

    const errors = this.predictions.map(p =>
      Math.abs(p.predicted - p.actual) / Math.max(p.actual, 1),
    );
    const avgError = errors.reduce((sum, err) => sum + err, 0) / errors.length;

    return Math.max(0, 1 - avgError); // Convert error to accuracy
  }

  getTrainingDataSize(): number {
    return this.trainingData.length;
  }
}