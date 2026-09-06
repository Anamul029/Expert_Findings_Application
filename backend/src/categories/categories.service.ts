import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { Category } from './entities/category.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: Repository<Category>,
  ) {}

  async createACategory(createCategoryDto: CreateCategoryDto) {
    const { parent_id, ...categoryData } = createCategoryDto;

    let parent: Category | null = null;

    if (parent_id) {
      parent = await this.categoryRepository.findOne({
        where: { id: parent_id },
      });

      if (!parent) {
        throw new NotFoundException(
          `Parent category with ID ${parent_id} not found`,
        );
      }
    }

    const category = this.categoryRepository.create({
      ...categoryData,
      parent,
    });

    return await this.categoryRepository.save(category);
  }

  async findAllCategories() {
    return await this.categoryRepository.find({
      relations: {
        // parent: true,
        children: true,
      },
      order: {
        id: 'DESC',
      },
    });
  }

  async findSingleCategory(id: number) {
    const category = await this.categoryRepository.findOne({
      where: { id },
      relations: {
        parent: true,
        children: true,
        qualifications: true,
        prices: true,
      },
    });

    if (!category) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }

    return category;
  }
  async updateACategory(id: number, updateCategoryDto: UpdateCategoryDto) {
    const category = await this.findSingleCategory(id);

    const { parent_id, ...categoryData } = updateCategoryDto;

    if (parent_id !== undefined && parent_id !== category.parent_id) {
      // Remove parent
      if (parent_id === null) {
        category.parent = null;
      } else {
        // Prevent a category from becoming its own parent
        if (parent_id === id) {
          throw new Error('A category cannot be its own parent');
        }

        const parent = await this.categoryRepository.findOne({
          where: { id: parent_id },
        });

        if (!parent) {
          throw new NotFoundException(
            `Parent category with ID ${parent_id} not found`,
          );
        }

        category.parent = parent;
      }
    }

    Object.assign(category, categoryData);

    return await this.categoryRepository.save(category);
  }

  async deleteACategory(id: number) {
    const category = await this.findSingleCategory(id);

    await this.categoryRepository.remove(category);

    return {
      message: 'Category deleted successfully',
    };
  }
}
